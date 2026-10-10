//! Pubky TLS proxy in front of the local testnet homeserver, with per-identity delay and failure rules.
//! The app reaches the homeserver through it (Compose publishes the host's 6287 here); without rules it only forwards.
//! The static testnet's homeserver key comes from the all-zero secret, so this proxy can present that same key.

use std::{
    collections::{BTreeMap, VecDeque},
    env,
    net::SocketAddr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, HeaderMap, HeaderName, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    serve::Listener,
    Json, Router,
};
use pkarr::Keypair;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{mpsc, watch, Mutex},
};
use tokio_rustls::{server::TlsStream, TlsAcceptor};

#[derive(Clone, Serialize, Deserialize)]
struct Rule {
    // the identity whose requests the rule holds (z32, with or without the `pubky` prefix)
    pubky: String,
    // owner-relative path prefix, such as `/pub/pubky.app/profile.json`; empty matches every path
    #[serde(default)]
    path: String,
    #[serde(default)]
    delay_ms: u64,
    // Wait for an explicit release, without a timer.
    #[serde(default)]
    hold: bool,
    // Restrict to one HTTP method; omitted matches all methods.
    #[serde(default)]
    method: Option<String>,
    // answer this status after the delay instead of forwarding
    #[serde(default)]
    status: Option<u16>,
}

#[derive(Clone)]
struct InstalledRule {
    rule: Rule,
    released: watch::Sender<bool>,
}

#[derive(Deserialize)]
struct RuleKey {
    pubky: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    method: Option<String>,
}

#[derive(Serialize)]
struct Pending {
    id: u64,
    at: u64,
    method: String,
    owner: Option<String>,
    path: String,
    rule_path: String,
    #[serde(skip)]
    released: watch::Receiver<bool>,
}

// Remove a request from the pending snapshot even when the client cancels it.
struct PendingGuard {
    proxy: Arc<Proxy>,
    id: u64,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.proxy.pending.lock().unwrap().remove(&self.id);
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |now| now.as_secs())
}

#[derive(Serialize)]
struct Seen {
    at: u64,
    method: String,
    owner: Option<String>,
    path: String,
    status: u16,
    delayed_ms: u64,
    held: bool,
}

struct Proxy {
    upstream: String,
    client: reqwest::Client,
    rules: Mutex<Vec<InstalledRule>>,
    pending: StdMutex<BTreeMap<u64, Pending>>,
    next_id: AtomicU64,
    seen: Mutex<VecDeque<Seen>>,
}

fn normalize(pubky: &str) -> String {
    let pubky = pubky.trim();
    match pubky.strip_prefix("pubky") {
        Some(rest) if rest.len() == 52 => rest.to_string(),
        _ => pubky.to_string(),
    }
}

/// The owner and owner-relative path of a homeserver request, read the way the homeserver reads them:
/// `/storage/<owner>/<path>`, else the `pubky-host` header, else a `_pubky.<owner>` or `<owner>` host.
fn tenant(headers: &HeaderMap, uri: &axum::http::Uri) -> (Option<String>, String) {
    let path = uri.path();
    if let Some((owner, rest)) = path
        .strip_prefix("/storage/")
        .and_then(|rest| rest.split_once('/'))
    {
        return (Some(owner.to_string()), format!("/{rest}"));
    }
    if let Some(owner) = headers
        .get("pubky-host")
        .and_then(|value| value.to_str().ok())
    {
        return (Some(normalize(owner)), path.to_string());
    }
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .or_else(|| uri.host())
        .unwrap_or_default();
    let host = host.split(':').next().unwrap_or_default();
    let host = host.strip_prefix("_pubky.").unwrap_or(host);
    let owner = (host.len() == 52).then(|| host.to_string());
    (owner, path.to_string())
}

const HOP_BY_HOP: [&str; 8] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

fn copy_headers(from: &HeaderMap) -> HeaderMap {
    let mut to = HeaderMap::new();
    for (name, value) in from {
        if !HOP_BY_HOP.contains(&name.as_str()) {
            to.append(HeaderName::from(name), value.clone());
        }
    }
    to
}

async fn forward(State(proxy): State<Arc<Proxy>>, request: Request) -> Response {
    let (owner, path) = tenant(request.headers(), request.uri());
    let method = request.method().to_string();
    let installed = match owner.as_ref() {
        Some(owner) => proxy
            .rules
            .lock()
            .await
            .iter()
            .filter(|known| {
                &known.rule.pubky == owner
                    && path.starts_with(&known.rule.path)
                    && known
                        .rule
                        .method
                        .as_ref()
                        .is_none_or(|value| value == &method)
            })
            .max_by_key(|known| (known.rule.method.is_some(), known.rule.path.len()))
            .cloned(),
        None => None,
    };
    let rule = installed.as_ref().map(|known| &known.rule);
    let started = Instant::now();
    let mut pending_guard = None;
    if let Some(known) = installed.as_ref().filter(|known| known.rule.hold) {
        let id = proxy.next_id.fetch_add(1, Ordering::Relaxed);
        // Subscribe before publishing the pending request so release cannot race past us.
        let mut released = known.released.subscribe();
        proxy.pending.lock().unwrap().insert(
            id,
            Pending {
                id,
                at: now(),
                method: method.clone(),
                owner: owner.clone(),
                path: path.clone(),
                rule_path: known.rule.path.clone(),
                released: released.clone(),
            },
        );
        pending_guard = Some(PendingGuard {
            proxy: proxy.clone(),
            id,
        });
        while !*released.borrow_and_update() {
            if released.changed().await.is_err() {
                break;
            }
        }
    } else if let Some(rule) = rule {
        tokio::time::sleep(Duration::from_millis(rule.delay_ms)).await;
    }
    drop(pending_guard);
    let delayed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    let response = match rule.as_ref().and_then(|rule| rule.status) {
        Some(status) => (
            StatusCode::from_u16(status).unwrap_or(StatusCode::SERVICE_UNAVAILABLE),
            "homeserver-proxy: injected failure",
        )
            .into_response(),
        None => relay(&proxy, request).await,
    };
    let status = response.status().as_u16();
    println!(
        "{method} {} {path} -> {status}{}",
        owner.as_deref().unwrap_or("-"),
        if delayed_ms > 0 {
            format!(" (delayed {delayed_ms} ms)")
        } else {
            String::new()
        }
    );
    let mut seen = proxy.seen.lock().await;
    if seen.len() == 200 {
        seen.pop_front();
    }
    seen.push_back(Seen {
        at: now(),
        method,
        owner,
        path,
        status,
        delayed_ms,
        held: rule.is_some_and(|rule| rule.hold),
    });
    response
}

async fn relay(proxy: &Proxy, request: Request) -> Response {
    let target = format!(
        "{}{}",
        proxy.upstream,
        request
            .uri()
            .path_and_query()
            .map_or("/", |value| value.as_str())
    );
    let method = request.method().clone();
    let headers = copy_headers(request.headers());
    let body = reqwest::Body::wrap_stream(request.into_body().into_data_stream());
    match proxy
        .client
        .request(method, target)
        .headers(headers)
        .body(body)
        .send()
        .await
    {
        Ok(upstream) => {
            let mut response = Response::builder().status(upstream.status().as_u16());
            if let Some(headers) = response.headers_mut() {
                *headers = copy_headers(upstream.headers());
            }
            response
                .body(Body::from_stream(upstream.bytes_stream()))
                .unwrap_or_else(|error| {
                    (StatusCode::BAD_GATEWAY, error.to_string()).into_response()
                })
        }
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            format!("homeserver-proxy: {error}"),
        )
            .into_response(),
    }
}

async fn list_rules(State(proxy): State<Arc<Proxy>>) -> Json<Value> {
    let rules = proxy.rules.lock().await;
    Json(json!({ "rules": rules.iter().map(|known| &known.rule).collect::<Vec<_>>() }))
}

fn normalize_method(method: &mut Option<String>) -> Result<(), (StatusCode, String)> {
    if let Some(value) = method {
        *value = value.to_ascii_uppercase();
        value
            .parse::<axum::http::Method>()
            .map_err(|_| (StatusCode::BAD_REQUEST, "invalid method".into()))?;
    }
    Ok(())
}

fn same_key(rule: &Rule, pubky: &str, path: &str, method: &Option<String>) -> bool {
    rule.pubky == pubky && rule.path == path && &rule.method == method
}

/// Replacement releases requests already waiting on the previous rule.
async fn add_rule(
    State(proxy): State<Arc<Proxy>>,
    Json(mut rule): Json<Rule>,
) -> Result<Json<Value>, (StatusCode, String)> {
    rule.pubky = normalize(&rule.pubky);
    normalize_method(&mut rule.method)?;
    if rule.hold && rule.delay_ms != 0 {
        return Err((
            StatusCode::BAD_REQUEST,
            "hold and delay_ms are mutually exclusive".into(),
        ));
    }
    if rule
        .status
        .is_some_and(|status| StatusCode::from_u16(status).is_err())
    {
        return Err((StatusCode::BAD_REQUEST, "invalid status".into()));
    }
    let mut rules = proxy.rules.lock().await;
    rules.retain(|known| {
        let keep = !same_key(&known.rule, &rule.pubky, &rule.path, &rule.method);
        if !keep {
            known.released.send_replace(true);
        }
        keep
    });
    let (released, _) = watch::channel(false);
    rules.push(InstalledRule { rule, released });
    Ok(Json(
        json!({ "rules": rules.iter().map(|known| &known.rule).collect::<Vec<_>>() }),
    ))
}

/// Remove only the selected rule and release its waiting requests; preserve other faults.
async fn release_rule(
    State(proxy): State<Arc<Proxy>>,
    Json(mut key): Json<RuleKey>,
) -> Result<Json<Value>, (StatusCode, String)> {
    key.pubky = normalize(&key.pubky);
    normalize_method(&mut key.method)?;
    let mut rules = proxy.rules.lock().await;
    let mut count = 0;
    rules.retain(|known| {
        let keep = !same_key(&known.rule, &key.pubky, &key.path, &key.method);
        if !keep {
            known.released.send_replace(true);
            count += 1;
        }
        keep
    });
    Ok(Json(json!({ "released": count,
        "rules": rules.iter().map(|known| &known.rule).collect::<Vec<_>>() })))
}

async fn clear_rules(State(proxy): State<Arc<Proxy>>) -> Json<Value> {
    for known in proxy.rules.lock().await.drain(..) {
        known.released.send_replace(true);
    }
    Json(json!({ "rules": [] }))
}

async fn requests(State(proxy): State<Arc<Proxy>>) -> Json<Value> {
    let seen = proxy.seen.lock().await;
    let pending = proxy.pending.lock().unwrap();
    Json(
        json!({ "requests": *seen, "pending": pending.values().filter(|request| !*request.released.borrow()).collect::<Vec<_>>() }),
    )
}

fn control_router(proxy: Arc<Proxy>) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/rules", get(list_rules).post(add_rule).delete(clear_rules))
        .route("/rules/release", axum::routing::post(release_rule))
        .route("/requests", get(requests))
        .with_state(proxy)
}

/// Accepts TCP connections and finishes each TLS handshake on its own task, so one slow client does not hold the others.
struct TlsListener {
    local: SocketAddr,
    ready: mpsc::Receiver<(TlsStream<TcpStream>, SocketAddr)>,
}

impl TlsListener {
    async fn bind(addr: SocketAddr, acceptor: TlsAcceptor) -> Result<Self> {
        let listener = TcpListener::bind(addr).await?;
        let local = listener.local_addr()?;
        let (sender, ready) = mpsc::channel(64);
        tokio::spawn(async move {
            loop {
                let Ok((stream, peer)) = listener.accept().await else {
                    continue;
                };
                let (acceptor, sender) = (acceptor.clone(), sender.clone());
                tokio::spawn(async move {
                    match tokio::time::timeout(Duration::from_secs(10), acceptor.accept(stream))
                        .await
                    {
                        Ok(Ok(tls)) => {
                            let _ = sender.send((tls, peer)).await;
                        }
                        // the Pubky client's reachability probe connects and closes without a handshake
                        Ok(Err(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof => {}
                        Ok(Err(error)) => eprintln!("tls handshake from {peer} failed: {error}"),
                        Err(_) => eprintln!("tls handshake from {peer} timed out"),
                    }
                });
            }
        });
        Ok(Self { local, ready })
    }
}

impl Listener for TlsListener {
    type Io = TlsStream<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            if let Some(next) = self.ready.recv().await {
                return next;
            }
        }
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        Ok(self.local)
    }
}

fn port(name: &str, default: u16) -> Result<u16> {
    env::var(name).map_or(Ok(default), |value| {
        value
            .parse()
            .with_context(|| format!("{name} is not a port"))
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    let keypair = Keypair::from_secret_key(&[0; 32]);
    let tls_port = port("PROXY_TLS_PORT", 6297)?;
    let control_port = port("PROXY_CONTROL_PORT", 6298)?;
    let upstream = env::var("PROXY_UPSTREAM").unwrap_or_else(|_| "http://127.0.0.1:6286".into());
    let proxy = Arc::new(Proxy {
        upstream,
        client: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?,
        rules: Mutex::new(Vec::new()),
        pending: StdMutex::new(BTreeMap::new()),
        next_id: AtomicU64::new(1),
        seen: Mutex::new(VecDeque::new()),
    });
    let acceptor = TlsAcceptor::from(Arc::new(keypair.to_rpk_rustls_server_config()));
    let tls = TlsListener::bind(([0, 0, 0, 0], tls_port).into(), acceptor).await?;
    let control = TcpListener::bind(("0.0.0.0", control_port)).await?;
    println!(
        "homeserver-proxy: Pubky TLS as {} on {tls_port} -> {}, control on {control_port}",
        keypair.public_key(),
        proxy.upstream
    );
    let forwarding = Router::new().fallback(forward).with_state(proxy.clone());
    let controls = control_router(proxy);
    tokio::try_join!(async { axum::serve(tls, forwarding).await }, async {
        axum::serve(control, controls).await
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_rustls::rustls;

    // Pin the fixture's raw public key, without a DHT lookup or an external service.
    #[derive(Debug)]
    struct FixtureKey;

    impl rustls::client::danger::ServerCertVerifier for FixtureKey {
        fn verify_server_cert(
            &self,
            cert: &rustls::pki_types::CertificateDer<'_>,
            intermediates: &[rustls::pki_types::CertificateDer<'_>],
            _name: &rustls::pki_types::ServerName<'_>,
            _ocsp: &[u8],
            _now: rustls::pki_types::UnixTime,
        ) -> std::result::Result<rustls::client::danger::ServerCertVerified, rustls::Error>
        {
            let expected = Keypair::from_secret_key(&[0; 32]).to_rpk_certified_key();
            if !intermediates.is_empty() || cert != &expected.cert[0] {
                return Err(rustls::Error::InvalidCertificate(
                    rustls::CertificateError::UnknownIssuer,
                ));
            }
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        }

        fn verify_tls12_signature(
            &self,
            message: &[u8],
            cert: &rustls::pki_types::CertificateDer<'_>,
            signature: &rustls::DigitallySignedStruct,
        ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error>
        {
            self.verify_tls13_signature(message, cert, signature)
        }

        fn verify_tls13_signature(
            &self,
            message: &[u8],
            cert: &rustls::pki_types::CertificateDer<'_>,
            signature: &rustls::DigitallySignedStruct,
        ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error>
        {
            rustls::crypto::verify_tls13_signature_with_raw_key(
                message,
                &rustls::pki_types::SubjectPublicKeyInfoDer::from(cert.as_ref()),
                signature,
                &rustls::crypto::ring::default_provider().signature_verification_algorithms,
            )
        }

        fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
            vec![rustls::SignatureScheme::ED25519]
        }

        fn requires_raw_public_keys(&self) -> bool {
            true
        }
    }

    fn fixture_client() -> reqwest::Client {
        let config = rustls::ClientConfig::builder_with_provider(
            rustls::crypto::ring::default_provider().into(),
        )
        .with_safe_default_protocol_versions()
        .unwrap()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(FixtureKey))
        .with_no_client_auth();
        reqwest::Client::builder()
            .use_preconfigured_tls(config)
            .build()
            .unwrap()
    }

    const OWNER: &str = "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";
    const OTHER: &str = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";

    struct Harness {
        proxy: Arc<Proxy>,
        client: reqwest::Client,
        control: String,
        data: String,
        forwarded: Arc<AtomicU64>,
        servers: Vec<tokio::task::JoinHandle<()>>,
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            for task in &self.servers {
                task.abort();
            }
        }
    }

    impl Harness {
        async fn start() -> Self {
            let forwarded = Arc::new(AtomicU64::new(0));
            let count = forwarded.clone();
            let upstream = Router::new().fallback(move || {
                let count = count.clone();
                async move {
                    count.fetch_add(1, Ordering::Relaxed);
                    "upstream record"
                }
            });
            let mut servers = Vec::new();
            let upstream_url = Self::serve(upstream, &mut servers).await;
            let proxy = Arc::new(Proxy {
                upstream: upstream_url,
                client: reqwest::Client::new(),
                rules: Mutex::new(Vec::new()),
                pending: StdMutex::new(BTreeMap::new()),
                next_id: AtomicU64::new(1),
                seen: Mutex::new(VecDeque::new()),
            });
            let control = Self::serve(control_router(proxy.clone()), &mut servers).await;
            let acceptor = TlsAcceptor::from(Arc::new(
                Keypair::from_secret_key(&[0; 32]).to_rpk_rustls_server_config(),
            ));
            let tls = TlsListener::bind(([127, 0, 0, 1], 0).into(), acceptor)
                .await
                .unwrap();
            let data = format!("https://{}", tls.local_addr().unwrap());
            let router = Router::new().fallback(forward).with_state(proxy.clone());
            servers.push(tokio::spawn(async move {
                axum::serve(tls, router).await.unwrap();
            }));
            Self {
                proxy,
                client: fixture_client(),
                control,
                data,
                forwarded,
                servers,
            }
        }

        async fn serve(router: Router, tasks: &mut Vec<tokio::task::JoinHandle<()>>) -> String {
            let socket = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = socket.local_addr().unwrap();
            tasks.push(tokio::spawn(async move {
                axum::serve(socket, router).await.unwrap();
            }));
            format!("http://{address}")
        }

        async fn post(&self, path: &str, value: Value) -> Value {
            self.client
                .post(format!("{}{path}", self.control))
                .json(&value)
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .json()
                .await
                .unwrap()
        }

        fn request(
            &self,
            owner: &str,
            method: &str,
            path: &str,
        ) -> tokio::task::JoinHandle<reqwest::Response> {
            let client = self.client.clone();
            let url = format!("{}{path}", self.data);
            let owner = owner.to_string();
            let method = method.parse::<axum::http::Method>().unwrap();
            tokio::spawn(async move {
                client
                    .request(method, url)
                    .header("pubky-host", owner)
                    .send()
                    .await
                    .unwrap()
            })
        }

        async fn pending(&self, count: usize) -> Value {
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let snapshot: Value = self
                        .client
                        .get(format!("{}/requests", self.control))
                        .send()
                        .await
                        .unwrap()
                        .json()
                        .await
                        .unwrap();
                    if snapshot["pending"].as_array().unwrap().len() == count {
                        return snapshot;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("pending request snapshot")
        }

        async fn finish(task: tokio::task::JoinHandle<reqwest::Response>) -> reqwest::Response {
            tokio::time::timeout(Duration::from_secs(3), task)
                .await
                .unwrap()
                .unwrap()
        }
    }

    #[tokio::test]
    async fn hold_waits_for_explicit_release_and_exposes_arrival() {
        let h = Harness::start().await;
        h.post(
            "/rules",
            json!({"pubky": OWNER, "path": "/profile", "hold": true}),
        )
        .await;
        let task = h.request(OWNER, "GET", "/profile");
        let snapshot = h.pending(1).await;
        assert_eq!(snapshot["pending"][0]["owner"], OWNER);
        assert_eq!(snapshot["pending"][0]["method"], "GET");
        assert_eq!(snapshot["pending"][0]["path"], "/profile");
        assert!(snapshot["requests"].as_array().unwrap().is_empty());
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!task.is_finished());
        assert_eq!(h.forwarded.load(Ordering::Relaxed), 0);
        h.post(
            "/rules/release",
            json!({"pubky": format!("pubky{OWNER}"), "path": "/profile"}),
        )
        .await;
        let response = Harness::finish(task).await;
        assert_eq!(response.text().await.unwrap(), "upstream record");
        let snapshot = h.pending(0).await;
        assert_eq!(snapshot["requests"][0]["held"], true);
        assert!(snapshot["requests"][0]["delayed_ms"].as_u64().unwrap() >= 100);
    }

    #[tokio::test]
    async fn simultaneous_withdrawal_and_publication_can_be_released_separately() {
        let h = Harness::start().await;
        for method in ["delete", "put"] {
            h.post(
                "/rules",
                json!({"pubky": OWNER, "path": "/pub/paykit", "method": method, "hold": true}),
            )
            .await;
        }
        let withdraw = h.request(OWNER, "DELETE", "/pub/paykit/endpoint");
        let publish = h.request(OWNER, "PUT", "/pub/paykit/endpoint");
        h.pending(2).await;
        assert_eq!(
            Harness::finish(h.request(OWNER, "GET", "/pub/paykit/endpoint"))
                .await
                .status(),
            200
        );
        assert_eq!(
            Harness::finish(h.request(OTHER, "PUT", "/pub/paykit/endpoint"))
                .await
                .status(),
            200
        );
        h.post(
            "/rules/release",
            json!({"pubky": OWNER, "path": "/pub/paykit", "method": "put"}),
        )
        .await;
        assert_eq!(Harness::finish(publish).await.status(), 200);
        h.pending(1).await;
        assert!(!withdraw.is_finished());
        h.client
            .delete(format!("{}/rules", h.control))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        assert_eq!(Harness::finish(withdraw).await.status(), 200);
        h.pending(0).await;
    }

    #[tokio::test]
    async fn missing_peer_reads_remain_404_while_writes_are_held() {
        let h = Harness::start().await;
        h.post(
            "/rules",
            json!({"pubky": OWNER, "path": "/pub/paykit", "method": "PUT", "hold": true}),
        )
        .await;
        h.post(
            "/rules",
            json!({"pubky": OWNER, "path": "/pub/paykit", "method": "GET", "status": 404}),
        )
        .await;
        let publish = h.request(OWNER, "PUT", "/pub/paykit/noise-key");
        h.pending(1).await;
        for _ in 0..3 {
            assert_eq!(
                Harness::finish(h.request(OWNER, "GET", "/pub/paykit/noise-key"))
                    .await
                    .status(),
                404
            );
        }
        assert_eq!(h.forwarded.load(Ordering::Relaxed), 0);
        h.post(
            "/rules/release",
            json!({"pubky": OWNER, "path": "/pub/paykit", "method": "PUT"}),
        )
        .await;
        Harness::finish(publish).await;
        assert_eq!(
            Harness::finish(h.request(OWNER, "GET", "/pub/paykit/noise-key"))
                .await
                .status(),
            404
        );
        h.post(
            "/rules/release",
            json!({"pubky": OWNER, "path": "/pub/paykit", "method": "GET"}),
        )
        .await;
        assert_eq!(
            Harness::finish(h.request(OWNER, "GET", "/pub/paykit/noise-key"))
                .await
                .status(),
            200
        );
    }

    #[tokio::test]
    async fn replacing_a_rule_releases_its_waiters_and_applies_new_status_to_new_requests() {
        let h = Harness::start().await;
        h.post(
            "/rules",
            json!({"pubky": OWNER, "path": "", "hold": true, "status": 404}),
        )
        .await;
        let task = h.request(OWNER, "GET", "/record");
        h.pending(1).await;
        h.post("/rules", json!({"pubky": OWNER, "path": "", "status": 503}))
            .await;
        assert_eq!(Harness::finish(task).await.status(), 404);
        assert_eq!(
            Harness::finish(h.request(OWNER, "GET", "/record"))
                .await
                .status(),
            503
        );
    }

    #[tokio::test]
    async fn cancelled_hold_does_not_leave_a_pending_entry() {
        let h = Harness::start().await;
        h.post("/rules", json!({"pubky": OWNER, "hold": true}))
            .await;
        let request = Request::builder()
            .uri("/profile")
            .header("pubky-host", OWNER)
            .body(Body::empty())
            .unwrap();
        let proxy = h.proxy.clone();
        let task = tokio::spawn(async move { forward(State(proxy), request).await });
        h.pending(1).await;
        task.abort();
        let _ = task.await;
        h.pending(0).await;
    }

    #[tokio::test]
    async fn longest_path_wins_and_legacy_delay_still_forwards() {
        let h = Harness::start().await;
        h.post("/rules", json!({"pubky": OWNER, "path": "", "status": 503}))
            .await;
        h.post(
            "/rules",
            json!({"pubky": OWNER, "path": "/profile", "delay_ms": 30}),
        )
        .await;
        let start = Instant::now();
        assert_eq!(
            Harness::finish(h.request(OWNER, "GET", "/profile"))
                .await
                .status(),
            200
        );
        assert!(start.elapsed() >= Duration::from_millis(30));
    }

    #[tokio::test]
    async fn invalid_rules_are_rejected_without_releasing_an_existing_hold() {
        let h = Harness::start().await;
        h.post("/rules", json!({"pubky": OWNER, "hold": true}))
            .await;
        let task = h.request(OWNER, "GET", "/record");
        h.pending(1).await;
        for bad in [
            json!({"pubky": OWNER, "hold": true, "delay_ms": 1}),
            json!({"pubky": OWNER, "status": 0}),
            json!({"pubky": OWNER, "method": "bad method"}),
        ] {
            assert_eq!(
                h.client
                    .post(format!("{}/rules", h.control))
                    .json(&bad)
                    .send()
                    .await
                    .unwrap()
                    .status(),
                400
            );
        }
        assert!(!task.is_finished());
        h.client
            .delete(format!("{}/rules", h.control))
            .send()
            .await
            .unwrap();
        Harness::finish(task).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn wait_command_observes_live_overlap_over_control_http() {
        let h = Harness::start().await;
        for method in ["DELETE", "PUT"] {
            h.post(
                "/rules",
                json!({"pubky": OWNER, "method": method, "hold": true}),
            )
            .await;
        }
        let withdraw = h.request(OWNER, "DELETE", "/record");
        let publish = h.request(OWNER, "PUT", "/record");
        h.pending(2).await;
        let control = h.control.clone();
        let script =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/homeserver-wait.py");
        let output = tokio::task::spawn_blocking(move || {
            std::process::Command::new("python3")
                .arg(script)
                .args([
                    "--control",
                    &control,
                    "--owner",
                    OWNER,
                    "--method",
                    "DELETE",
                    "--method",
                    "PUT",
                    "--timeout",
                    "2",
                ])
                .output()
                .unwrap()
        })
        .await
        .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let snapshot: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(snapshot["pending"].as_array().unwrap().len(), 2);
        assert!(!withdraw.is_finished() && !publish.is_finished());
        h.client
            .delete(format!("{}/rules", h.control))
            .send()
            .await
            .unwrap();
        Harness::finish(withdraw).await;
        Harness::finish(publish).await;
    }

    // Optional fixture-only check of a separately deployed proxy. No app or real peer is used.
    #[tokio::test]
    #[ignore = "set PROXY_SMOKE_CONTROL and PROXY_SMOKE_TLS for an isolated proxy"]
    async fn deployed_proxy_smoke() {
        let client = fixture_client();
        let control = env::var("PROXY_SMOKE_CONTROL").unwrap();
        let data = env::var("PROXY_SMOKE_TLS").unwrap();
        for method in ["PUT", "DELETE"] {
            client
                .post(format!("{control}/rules"))
                .json(&json!({"pubky": OWNER, "method": method, "hold": true}))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
        }
        client
            .post(format!("{control}/rules"))
            .json(&json!({"pubky": OWNER, "method": "GET", "status": 404}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        let mut writes = Vec::new();
        for method in ["PUT", "DELETE"] {
            let client = client.clone();
            let url = format!("{data}/storage/{OWNER}/pub/paykit/smoke");
            writes.push(tokio::spawn(async move {
                client
                    .request(method.parse::<axum::http::Method>().unwrap(), url)
                    .send()
                    .await
                    .unwrap()
            }));
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let snapshot: Value = client
                    .get(format!("{control}/requests"))
                    .send()
                    .await
                    .unwrap()
                    .json()
                    .await
                    .unwrap();
                if snapshot["pending"].as_array().unwrap().len() == 2 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        // Outlast the 20-second delays used by the failed setup, without app driving.
        tokio::time::sleep(Duration::from_secs(21)).await;
        for _ in 0..2 {
            assert_eq!(
                client
                    .get(format!("{data}/storage/{OWNER}/pub/paykit/smoke"))
                    .send()
                    .await
                    .unwrap()
                    .status(),
                404
            );
        }
        let snapshot: Value = client
            .get(format!("{control}/requests"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(snapshot["pending"].as_array().unwrap().len(), 2);
        assert!(writes.iter().all(|task| !task.is_finished()));
        println!(
            "deployed proxy: PUT and DELETE still held after 21 seconds; peer GET -> 404 twice"
        );
        for method in ["PUT", "DELETE"] {
            let response: Value = client
                .post(format!("{control}/rules/release"))
                .json(&json!({"pubky": OWNER, "method": method}))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(response["released"], 1);
        }
        for task in writes {
            // This isolated deployment deliberately has no upstream: release must attempt relay.
            assert_eq!(Harness::finish(task).await.status(), 502);
        }
        assert_eq!(
            client
                .get(format!("{data}/storage/{OWNER}/pub/paykit/smoke"))
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        client
            .delete(format!("{control}/rules"))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        let rules: Value = client
            .get(format!("{control}/rules"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(rules["rules"].as_array().unwrap().is_empty());
        println!("deployed proxy: targeted release forwards writes; GET fault survives; cleanup cleared rules");
    }
}
