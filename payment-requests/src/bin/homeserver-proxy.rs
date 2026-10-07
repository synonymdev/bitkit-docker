//! Pubky TLS proxy in front of the local testnet homeserver, with per-identity delay and failure rules.
//! The app reaches the homeserver through it (Compose publishes the host's 6287 here); without rules it only forwards.
//! The static testnet's homeserver key comes from the all-zero secret, so this proxy can present that same key.

use std::{
    collections::VecDeque,
    env,
    net::SocketAddr,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
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
    sync::{mpsc, Mutex},
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
    // answer this status after the delay instead of forwarding
    #[serde(default)]
    status: Option<u16>,
}

#[derive(Serialize)]
struct Seen {
    at: u64,
    method: String,
    owner: Option<String>,
    path: String,
    status: u16,
    delayed_ms: u64,
}

struct Proxy {
    upstream: String,
    client: reqwest::Client,
    rules: Mutex<Vec<Rule>>,
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
    if let Some((owner, rest)) = path.strip_prefix("/storage/").and_then(|rest| rest.split_once('/')) {
        return (Some(owner.to_string()), format!("/{rest}"));
    }
    if let Some(owner) = headers.get("pubky-host").and_then(|value| value.to_str().ok()) {
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
    let rule = match owner.as_ref() {
        Some(owner) => proxy
            .rules
            .lock()
            .await
            .iter()
            .find(|rule| &rule.pubky == owner && path.starts_with(&rule.path))
            .cloned(),
        None => None,
    };
    let delayed_ms = rule.as_ref().map_or(0, |rule| rule.delay_ms);
    if delayed_ms > 0 {
        tokio::time::sleep(Duration::from_millis(delayed_ms)).await;
    }
    let method = request.method().to_string();
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
        if delayed_ms > 0 { format!(" (delayed {delayed_ms} ms)") } else { String::new() }
    );
    let mut seen = proxy.seen.lock().await;
    if seen.len() == 200 {
        seen.pop_front();
    }
    seen.push_back(Seen {
        at: SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |now| now.as_secs()),
        method,
        owner,
        path,
        status,
        delayed_ms,
    });
    response
}

async fn relay(proxy: &Proxy, request: Request) -> Response {
    let target = format!(
        "{}{}",
        proxy.upstream,
        request.uri().path_and_query().map_or("/", |value| value.as_str())
    );
    let method = request.method().clone();
    let headers = copy_headers(request.headers());
    let body = reqwest::Body::wrap_stream(request.into_body().into_data_stream());
    match proxy.client.request(method, target).headers(headers).body(body).send().await {
        Ok(upstream) => {
            let mut response = Response::builder().status(upstream.status().as_u16());
            if let Some(headers) = response.headers_mut() {
                *headers = copy_headers(upstream.headers());
            }
            response
                .body(Body::from_stream(upstream.bytes_stream()))
                .unwrap_or_else(|error| (StatusCode::BAD_GATEWAY, error.to_string()).into_response())
        }
        Err(error) => (StatusCode::BAD_GATEWAY, format!("homeserver-proxy: {error}")).into_response(),
    }
}

async fn list_rules(State(proxy): State<Arc<Proxy>>) -> Json<Value> {
    Json(json!({ "rules": *proxy.rules.lock().await }))
}

/// Adds a rule, replacing one with the same identity and path.
async fn add_rule(State(proxy): State<Arc<Proxy>>, Json(mut rule): Json<Rule>) -> Json<Value> {
    rule.pubky = normalize(&rule.pubky);
    let mut rules = proxy.rules.lock().await;
    rules.retain(|known| !(known.pubky == rule.pubky && known.path == rule.path));
    rules.push(rule);
    Json(json!({ "rules": *rules }))
}

async fn clear_rules(State(proxy): State<Arc<Proxy>>) -> Json<Value> {
    proxy.rules.lock().await.clear();
    Json(json!({ "rules": [] }))
}

async fn requests(State(proxy): State<Arc<Proxy>>) -> Json<Value> {
    Json(json!({ "requests": *proxy.seen.lock().await }))
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
                let Ok((stream, peer)) = listener.accept().await else { continue };
                let (acceptor, sender) = (acceptor.clone(), sender.clone());
                tokio::spawn(async move {
                    match tokio::time::timeout(Duration::from_secs(10), acceptor.accept(stream)).await {
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
    env::var(name).map_or(Ok(default), |value| value.parse().with_context(|| format!("{name} is not a port")))
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
    let controls = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/rules", get(list_rules).post(add_rule).delete(clear_rules))
        .route("/requests", get(requests))
        .with_state(proxy);
    tokio::try_join!(async { axum::serve(tls, forwarding).await }, async { axum::serve(control, controls).await })?;
    Ok(())
}
