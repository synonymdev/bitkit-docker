//! Disposable rc56 Paykit peer for Bitkit regtest journeys.
//! Two Compose services run this binary with separate identities and receiver paths.
#![recursion_limit = "512"]

use std::{env, future::Future, sync::Arc, time::Instant};

use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{Duration, SecondsFormat, Utc};
use paykit_lib::{
    BillingPeriod, PaymentAmount, PaymentDeadline, PaymentEndpointIdentifier, PaymentReference,
    PaymentRequestId, PaymentRequestTerms, Recurrence, RecurrenceConfig, RecurrenceUnit,
};
use paykit_sdk::{
    InMemoryStorage, LinkedPeerState, PaykitReceiverCapabilities, PaykitReceiverPath, PaykitSdk,
    PaykitSdkConfig, PaymentAdapter, PaymentRequestLifecycleState, PubkyLocalSecretKey,
    PubkyPublicKey, PubkySessionAccess, PubkySessionBootstrap, PubkySessionProvider,
    ReceiverNoiseSecretKey,
};
use pubky::{Keypair, Pubky};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;

const HOMESERVER: &str = "pubky8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo";
const ENDPOINT: &str = "btc-regtest-p2wpkh";

#[derive(Clone)]
struct SessionProvider(Arc<Mutex<Option<PubkySessionAccess>>>);

#[async_trait]
impl PubkySessionProvider for SessionProvider {
    async fn load_session_access(&self) -> paykit_sdk::Result<Option<PubkySessionAccess>> {
        Ok(self.0.lock().await.clone())
    }

    async fn load_public_storage(&self) -> paykit_sdk::Result<Option<pubky::PublicStorage>> {
        Ok(self
            .0
            .lock()
            .await
            .as_ref()
            .map(|access| access.outbox_client.public_storage()))
    }

    async fn clear_session_access(&self) -> paykit_sdk::Result<()> {
        *self.0.lock().await = None;
        Ok(())
    }
}

struct FixturePaymentAdapter;
#[async_trait]
impl PaymentAdapter for FixturePaymentAdapter {}

type FixtureSdk = PaykitSdk<InMemoryStorage, SessionProvider, FixturePaymentAdapter>;

struct App {
    sdk: FixtureSdk,
    pubky: PubkyPublicKey,
    receiver_path: PaykitReceiverPath,
    address: String,
    role: String,
    // The SDK stores per-peer operation leases; serialize manual control calls.
    operation: Mutex<()>,
}

#[derive(Deserialize)]
struct Peer {
    peer_pubky: String,
    peer_path: String,
}

impl Peer {
    fn parsed(&self) -> Result<(PubkyPublicKey, PaykitReceiverPath)> {
        Ok((
            PubkyPublicKey::from_raw_or_app_key(&self.peer_pubky)?,
            PaykitReceiverPath::new(&self.peer_path)?,
        ))
    }
}

#[derive(Deserialize)]
struct LinkInput {
    #[serde(flatten)]
    peer: Peer,
    mode: String,
}

#[derive(Deserialize)]
struct RequestInput {
    #[serde(flatten)]
    peer: Peer,
    amount_sats: u64,
    reference: String,
    deadline_at: Option<String>,
    monthly_starts_at: Option<String>,
    period_start_deadline_seconds: Option<u64>,
}

#[derive(Deserialize)]
struct RecordInput {
    #[serde(flatten)]
    peer: Peer,
    payment_request_id: String,
}

#[derive(Deserialize)]
struct PayInput {
    #[serde(flatten)]
    record: RecordInput,
    address: String,
    amount_sats: u64,
    txid: Option<String>,
    billing_period_start: Option<String>,
    billing_period_end: Option<String>,
}

struct ApiError(anyhow::Error);
impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(error: E) -> Self {
        Self(error.into())
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": self.0.to_string() })),
        )
            .into_response()
    }
}
type ApiResult = std::result::Result<Json<Value>, ApiError>;

async fn rpc(method: &str, params: Value) -> Result<Value> {
    let url = env::var("BITCOIN_RPC_URL").unwrap_or_else(|_| "http://bitcoind:43782".into());
    let response: Value = reqwest::Client::new()
        .post(url)
        .basic_auth("polaruser", Some("polarpass"))
        .json(&json!({ "jsonrpc": "1.0", "id": "payment-fixture", "method": method, "params": params }))
        .send()
        .await?
        .json()
        .await?;
    if !response["error"].is_null() {
        bail!("bitcoind {method}: {}", response["error"]);
    }
    Ok(response["result"].clone())
}

/// Retries a step that depends on the Pubky testnet or bitcoind, which may still be starting when this
/// container starts (Compose only waits for their containers to exist). Bounded by
/// `FIXTURE_SETUP_TIMEOUT_SECONDS` (default 120), so a broken dependency still ends in a clear exit.
async fn retry<T, F, Fut>(what: &str, mut attempt: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T>>,
{
    let timeout: u64 = env::var("FIXTURE_SETUP_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(120);
    let deadline = Instant::now() + std::time::Duration::from_secs(timeout);
    loop {
        match attempt().await {
            Ok(value) => return Ok(value),
            Err(error) if Instant::now() < deadline => {
                eprintln!("setup: {what} failed, retrying: {error:#}");
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
            Err(error) => return Err(error.context(format!("{what} still failing after {timeout}s"))),
        }
    }
}

async fn setup() -> Result<App> {
    let role = env::var("FIXTURE_ROLE").context("FIXTURE_ROLE is required")?;
    let receiver_path = PaykitReceiverPath::new(match role.as_str() {
        "fixture-issuer" => "bitkit/server",
        "rc56-peer" => "bitkit/wallet",
        _ => bail!("unknown FIXTURE_ROLE"),
    })?;
    let pubky = Pubky::testnet()?;
    let bootstrap = PubkySessionBootstrap::with_pubky(pubky, "bitkit-docker.fixture")?
        .with_auth_relay("http://localhost:15412/inbox")?;
    let config = PaykitSdkConfig::new(receiver_path.clone());
    let homeserver = PubkyPublicKey::from_raw_or_app_key(HOMESERVER)?;
    // A new identity per attempt: a failed sign-up must not leave the retry with a half-created account.
    let signed_up = retry("sign-up on the local homeserver", || async {
        let secret = PubkyLocalSecretKey::new(Keypair::random().secret_key());
        Ok(bootstrap
            .sign_up(
                &secret,
                ReceiverNoiseSecretKey::random(),
                &homeserver,
                None,
                &config.required_session_capabilities(),
            )
            .await?)
    })
    .await?;
    let provider = SessionProvider(Arc::new(Mutex::new(Some(signed_up.access))));
    let sdk = PaykitSdk::new(
        InMemoryStorage::default(),
        provider,
        FixturePaymentAdapter,
        config,
    )?;
    sdk.initialize().await?;
    retry("receiver marker publication", || async {
        Ok(sdk
            .publish_paykit_receiver_marker(PaykitReceiverCapabilities {
                private_payments: true,
                payment_requests: true,
                receipts: false,
                outgoing_payments: role == "rc56-peer",
            })
            .await?)
    })
    .await?;
    let address = retry("getnewaddress from bitcoind", || async {
        let address = rpc("getnewaddress", json!(["", "bech32"]))
            .await?
            .as_str()
            .context("bitcoind returned no address")?
            .to_owned();
        if !address.starts_with("bcrt1q") {
            bail!("bitcoind did not return a regtest bech32 address");
        }
        Ok(address)
    })
    .await?;
    let endpoint_payload = json!({ "value": address }).to_string();
    retry("Paykit endpoint publication", || async {
        let published = sdk
            .sync_public_endpoints_with_receiving_details(vec![paykit_sdk::PublicReceivingDetail {
                identifier: ENDPOINT.into(),
                payload: endpoint_payload.clone(),
            }])
            .await?;
        if !published.failed.is_empty() || published.published.len() != 1 {
            bail!("Paykit endpoint publication failed");
        }
        Ok(())
    })
    .await?;
    Ok(App {
        sdk,
        pubky: signed_up.public_key,
        receiver_path,
        address,
        role,
        operation: Mutex::new(()),
    })
}

async fn info(State(app): State<Arc<App>>) -> ApiResult {
    Ok(Json(json!({
        "status": "ready", "role": app.role, "pubky": app.pubky.to_app_key(),
        "receiver_path": app.receiver_path.as_str(), "endpoint": ENDPOINT,
        "address": app.address,
    })))
}

async fn link(State(app): State<Arc<App>>, Json(input): Json<LinkInput>) -> ApiResult {
    let _guard = app.operation.lock().await;
    let (peer, path) = input.peer.parsed()?;
    let report = match input.mode.as_str() {
        "initiate" => app.sdk.initiate_link_with_peer(peer, path).await?,
        "accept" => app.sdk.accept_link_with_peer(peer, path).await?,
        _ => return Err(anyhow!("mode must be initiate or accept").into()),
    };
    Ok(Json(serde_json::to_value(report)?))
}

async fn sync_locked(app: &App, peer: PubkyPublicKey, path: PaykitReceiverPath) -> Result<Value> {
    let current = app
        .sdk
        .linked_peers()
        .await?
        .into_iter()
        .find(|item| item.counterparty == peer && item.counterparty_receiver_path == path);
    let state = current.context("link not started")?.state;
    if state == LinkedPeerState::Linking {
        let report = app.sdk.advance_link_handshake(peer, path).await?;
        return Ok(json!({ "link": report }));
    }
    if state != LinkedPeerState::Linked {
        bail!("peer link is {state:?}");
    }
    let received = app
        .sdk
        .receive_private_messages(peer.clone(), path.clone())
        .await?;
    let sent = app
        .sdk
        .process_outbound_private_messages(peer.clone(), path.clone())
        .await?;
    let records = app.sdk.payment_requests_with(&peer, &path).await?;
    Ok(
        json!({ "link": "linked", "received": received.stream_item_ids.len(),
        "sent": sent.sent.len(), "failed": sent.failed.len(), "records": records }),
    )
}

async fn sync(State(app): State<Arc<App>>, Json(input): Json<Peer>) -> ApiResult {
    let _guard = app.operation.lock().await;
    let (peer, path) = input.parsed()?;
    Ok(Json(sync_locked(&app, peer, path).await?))
}

async fn issue(State(app): State<Arc<App>>, Json(input): Json<RequestInput>) -> ApiResult {
    let _guard = app.operation.lock().await;
    let (peer, path) = input.peer.parsed()?;
    if input.amount_sats == 0 || input.reference.is_empty() {
        return Err(anyhow!("amount_sats and reference are required").into());
    }
    let now = Utc::now();
    let terms = PaymentRequestTerms::builder(
        PaymentAmount::new(
            format!(
                "{}.{:08}",
                input.amount_sats / 100_000_000,
                input.amount_sats % 100_000_000
            ),
            "btc",
        )?,
        PaymentReference::new(input.reference)?,
        vec![PaymentEndpointIdentifier::new(ENDPOINT)?],
    );
    let terms = if let Some(start) = input.monthly_starts_at {
        let recurrence = Recurrence::try_from(RecurrenceConfig {
            every: 1,
            unit: RecurrenceUnit::Month,
            starts_at: start.clone(),
            anchor: start,
            ends_at: None,
        })?;
        terms
            .recurrence(Some(recurrence))
            .payment_deadline(Some(PaymentDeadline::PeriodStart {
                seconds: input.period_start_deadline_seconds.unwrap_or(86_400),
            }))
    } else {
        let deadline = input.deadline_at.unwrap_or_else(|| {
            (now + Duration::days(7)).to_rfc3339_opts(SecondsFormat::Secs, true)
        });
        terms.payment_deadline(Some(PaymentDeadline::At {
            timestamp: deadline,
        }))
    };
    let record = app
        .sdk
        .propose_payment_request(peer.clone(), path.clone(), terms.build()?)
        .await?;
    let sent = app
        .sdk
        .process_outbound_private_messages(peer, path)
        .await?;
    if !sent.failed.is_empty() || sent.sent.len() != 1 {
        return Err(anyhow!(
            "Payment Request delivery failed: {} failed, {} sent",
            sent.failed.len(),
            sent.sent.len()
        )
        .into());
    }
    Ok(Json(
        json!({ "payment_request_id": record.payment_request_id, "state": record.state,
        "deadline": record.terms.as_ref().and_then(|terms| terms.payment_deadline.as_ref()) }),
    ))
}

async fn records(State(app): State<Arc<App>>, Json(input): Json<Peer>) -> ApiResult {
    let _guard = app.operation.lock().await;
    let (peer, path) = input.parsed()?;
    Ok(Json(
        json!({ "records": app.sdk.payment_requests_with(&peer, &path).await? }),
    ))
}

async fn act(State(app): State<Arc<App>>, action: &'static str, input: RecordInput) -> ApiResult {
    let _guard = app.operation.lock().await;
    let (peer, path) = input.peer.parsed()?;
    let _ = app
        .sdk
        .receive_private_messages(peer.clone(), path.clone())
        .await?;
    let id = PaymentRequestId::new(input.payment_request_id)?;
    let record = match action {
        "accept" => {
            app.sdk
                .accept_payment_request(peer.clone(), path.clone(), &id)
                .await?
        }
        "reject" => {
            app.sdk
                .reject_payment_request(peer.clone(), path.clone(), &id, None)
                .await?
        }
        "cancel" => {
            app.sdk
                .cancel_payment_request(peer.clone(), path.clone(), &id, None)
                .await?
        }
        _ => unreachable!(),
    };
    let sent = app
        .sdk
        .process_outbound_private_messages(peer, path)
        .await?;
    if !sent.failed.is_empty() || sent.sent.len() != 1 {
        return Err(anyhow!("{action} delivery failed").into());
    }
    Ok(Json(
        json!({ "payment_request_id": record.payment_request_id, "state": record.state }),
    ))
}

async fn accept(State(app): State<Arc<App>>, Json(input): Json<RecordInput>) -> ApiResult {
    act(State(app), "accept", input).await
}
async fn reject(State(app): State<Arc<App>>, Json(input): Json<RecordInput>) -> ApiResult {
    act(State(app), "reject", input).await
}
async fn cancel(State(app): State<Arc<App>>, Json(input): Json<RecordInput>) -> ApiResult {
    act(State(app), "cancel", input).await
}

async fn pay_impl(app: Arc<App>, input: PayInput, existing_tx: bool) -> ApiResult {
    let _guard = app.operation.lock().await;
    let (peer, path) = input.record.peer.parsed()?;
    let id = PaymentRequestId::new(input.record.payment_request_id)?;
    let _ = app
        .sdk
        .receive_private_messages(peer.clone(), path.clone())
        .await?;
    let record = app
        .sdk
        .payment_requests_with(&peer, &path)
        .await?
        .into_iter()
        .find(|record| record.payment_request_id == id.as_str())
        .context("unknown Payment Request")?;
    if !matches!(
        record.state,
        PaymentRequestLifecycleState::Accepted | PaymentRequestLifecycleState::ActiveRecurring
    ) {
        return Err(anyhow!("Payment Request is not accepted").into());
    }
    if input.amount_sats == 0 || !input.address.starts_with("bcrt1") {
        return Err(anyhow!("positive amount_sats and regtest bech32 address required").into());
    }
    let amount = format!(
        "{}.{:08}",
        input.amount_sats / 100_000_000,
        input.amount_sats % 100_000_000
    );
    let terms = record.terms.context("Payment Request has no terms")?;
    if terms.amount.asset != "btc"
        || terms.amount.value.parse::<f64>().ok() != amount.parse::<f64>().ok()
    {
        return Err(anyhow!("payment amount does not match BTC request").into());
    }
    let period = match (input.billing_period_start, input.billing_period_end) {
        (Some(start), Some(end)) => Some(BillingPeriod::new(start, end)?),
        (None, None) => None,
        _ => return Err(anyhow!("both billing period bounds are required").into()),
    };
    if terms.recurrence.is_some() != period.is_some() {
        return Err(anyhow!("billing period required only for monthly requests").into());
    }
    let txid = if existing_tx {
        let txid = input.txid.context("txid required for /proof")?;
        let transaction = rpc("gettransaction", json!([txid])).await?;
        let matches_payment = transaction["details"].as_array().is_some_and(|details| {
            details.iter().any(|detail| {
                detail["category"] == "send"
                    && detail["address"] == input.address
                    && detail["amount"].as_f64().is_some_and(|value| {
                        (value.abs() - input.amount_sats as f64 / 100_000_000.0).abs() < 0.00000001
                    })
            })
        });
        if !matches_payment {
            return Err(anyhow!("txid has no matching regtest wallet payment").into());
        }
        txid
    } else {
        if input.txid.is_some() {
            return Err(anyhow!("use /proof to retry an existing transaction").into());
        }
        rpc(
            "sendtoaddress",
            json!([input.address, input.amount_sats as f64 / 100_000_000.0]),
        )
        .await?
        .as_str()
        .context("bitcoind returned no txid")?
        .to_owned()
    };
    let proof = json!({ "txid": txid }).as_object().unwrap().clone();
    let record = match app
        .sdk
        .submit_payment_proof(
            peer.clone(),
            path.clone(),
            &id,
            period,
            PaymentEndpointIdentifier::new(ENDPOINT)?,
            proof,
        )
        .await
    {
        Ok(record) => record,
        Err(error) => {
            return Ok(Json(
                json!({ "payment_request_id": id.as_str(), "txid": txid,
            "proof_sent": false, "error": error.to_string() }),
            ))
        }
    };
    let sent = app.sdk.process_outbound_private_messages(peer, path).await;
    let proof_sent = sent
        .as_ref()
        .is_ok_and(|report| report.failed.is_empty() && report.sent.len() == 1);
    Ok(Json(
        json!({ "payment_request_id": id.as_str(), "txid": txid,
        "state": record.state, "proof_sent": proof_sent }),
    ))
}

async fn pay(State(app): State<Arc<App>>, Json(input): Json<PayInput>) -> ApiResult {
    pay_impl(app, input, false).await
}

async fn proof(State(app): State<Arc<App>>, Json(input): Json<PayInput>) -> ApiResult {
    pay_impl(app, input, true).await
}

#[tokio::main]
async fn main() -> Result<()> {
    let app = Arc::new(setup().await?);
    let port: u16 = env::var("FIXTURE_PORT")
        .unwrap_or_else(|_| "3002".into())
        .parse()?;
    let router = Router::new()
        .route("/health", get(info))
        .route("/info", get(info))
        .route("/link", post(link))
        .route("/sync", post(sync))
        .route("/records", post(records))
        .route("/request", post(issue))
        .route("/accept", post(accept))
        .route("/reject", post(reject))
        .route("/cancel", post(cancel))
        .route("/pay", post(pay))
        .route("/proof", post(proof))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    axum::serve(listener, router).await?;
    Ok(())
}
