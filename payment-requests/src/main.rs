//! Disposable rc62 Paykit peer for Bitkit regtest journeys.
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
    PubkySharedStateStorage, StorageAdapter, LinkedPeerState, PaykitAppCapabilities, PaykitAppId, PaykitApp, PaykitSdk,
    PaykitSdkConfig, PaymentAdapter, PaymentRequestLifecycleState, PubkyLocalSecretKey,
    PubkyPublicKey, PubkySessionAccess, PubkySessionBootstrap, PubkySessionProvider,
    PAYKIT_AUTHORIZER_SESSION_CAPABILITIES,
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

type FixtureSdk = PaykitSdk<PubkySharedStateStorage, SessionProvider, FixturePaymentAdapter>;

struct App {
    sdk: FixtureSdk,
    // the SDK's own storage, to give a proposal the id a journey names (see `issue`)
    storage: PubkySharedStateStorage,
    pubky: PubkyPublicKey,
    receiver_path: PaykitAppId,
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
    fn parsed(&self) -> Result<PubkyPublicKey> {
        Ok(PubkyPublicKey::from_raw_or_app_key(&self.peer_pubky)?)
    }
}

#[derive(Deserialize)]
struct LinkInput {
    #[serde(flatten)]
    peer: Peer,
    #[serde(default)]
    #[allow(dead_code)]
    mode: String,
}

#[derive(Deserialize)]
struct RequestInput {
    #[serde(flatten)]
    peer: Peer,
    amount_sats: u64,
    reference: String,
    // the id a journey names for its request (the issuer contract of the Bitkit journeys: `71300000-0000-4000-8000-000000000001`); a random one without it
    payment_request_id: Option<String>,
    // a request with no deadline
    no_deadline: Option<bool>,
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
    // the issuer contract of the Bitkit journeys: the fixture issuer's App ID is `paykit-server`
    let default_app_id = if role == "fixture-issuer" { "paykit-server" } else { "qa-fixture" };
    let receiver_path = PaykitAppId::new(env::var("APP_ID").unwrap_or_else(|_| default_app_id.into()))?;
    let pubky = Pubky::testnet()?;
    let bootstrap = PubkySessionBootstrap::with_pubky(pubky, "bitkit-docker.fixture")?
        .with_auth_relay("http://localhost:15412/inbox")?;
    let config = PaykitSdkConfig::new(receiver_path.clone())?;
    let homeserver = PubkyPublicKey::from_raw_or_app_key(HOMESERVER)?;
    // A new identity per attempt: a failed sign-up must not leave the retry with a half-created account.
    let signed_up = retry("sign-up on the local homeserver", || async {
        let phrase_file = env::var("MNEMONIC_FILE").ok();
        let secret = if let Some(ref file) = phrase_file { PubkyLocalSecretKey::from_bip39_mnemonic(std::fs::read_to_string(file)?.trim())? } else { PubkyLocalSecretKey::new(Keypair::random().secret_key()) };
        if phrase_file.is_some() { return Ok(bootstrap.sign_in(&secret, PAYKIT_AUTHORIZER_SESSION_CAPABILITIES).await?); }
        Ok(bootstrap
            .sign_up(
                &secret,
                &homeserver,
                None,
                PAYKIT_AUTHORIZER_SESSION_CAPABILITIES,
            )
            .await?)
    })
    .await?;
    let provider = SessionProvider(Arc::new(Mutex::new(Some(signed_up.access))));
    let storage = PubkySharedStateStorage::new(provider.clone());
    let sdk = PaykitSdk::new(
        storage.clone(),
        provider,
        FixturePaymentAdapter,
        config,
    );
    sdk.initialize().await?;
    let imported = env::var("MNEMONIC_FILE").is_ok();
    if !imported {
    sdk.publish_paykit_noise_key_authorization().await?;
    retry("receiver marker publication", || async {
        Ok(sdk
            .publish_paykit_app(PaykitApp::new("QA Fixture", PaykitAppCapabilities {
                private_payments: true,
                payment_requests: true,
                receipts: false,
                outgoing_payments: role == "rc56-peer",
            })?)
            .await?)
    })
    .await?;
    }
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
    if !imported {
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
    }
    Ok(App {
        sdk,
        storage,
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
    let peer = input.peer.parsed()?;
    // the canonical link flow of the SDK (`initiate` and `accept` are one call: whichever side starts, it drives the handshake on); `mode` is kept in the
    // request for the testers that still send it and is not read
    let report = app.sdk.ensure_link_with_peer(peer, 1).await?;
    Ok(Json(serde_json::to_value(report)?))
}

async fn sync_locked(app: &App, peer: PubkyPublicKey) -> Result<Value> {
    let current = app
        .sdk
        .linked_peers()
        .await?
        .into_iter()
        .find(|item| item.counterparty == peer);
    let state = current.context("link not started")?.state;
    if state == LinkedPeerState::Linking {
        let report = app.sdk.ensure_link_with_peer(peer, 1).await?;
        return Ok(json!({ "link": report }));
    }
    if state != LinkedPeerState::Linked {
        bail!("peer link is {state:?}");
    }
    let received = app
        .sdk
        .receive_private_messages(peer.clone())
        .await?;
    let sent = app
        .sdk
        .process_outbound_private_messages(peer.clone())
        .await?;
    let records = app.sdk.payment_requests_with(&peer).await?;
    let lists = app.sdk.current_private_payment_lists(&peer).await?;
    Ok(
        json!({ "link": "linked", "received": received.stream_item_ids.len(),
        "sent": sent.sent.len(), "failed": sent.failed.len(), "records": records,
        "private_payment_lists": lists }),
    )
}

async fn sync(State(app): State<Arc<App>>, Json(input): Json<Peer>) -> ApiResult {
    let _guard = app.operation.lock().await;
    let peer = input.parsed()?;
    Ok(Json(sync_locked(&app, peer).await?))
}

async fn issue(State(app): State<Arc<App>>, Json(input): Json<RequestInput>) -> ApiResult {
    let _guard = app.operation.lock().await;
    let peer = input.peer.parsed()?;
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
    let fixed_id = input.payment_request_id;
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
    } else if input.no_deadline.unwrap_or(false) {
        terms
    } else {
        let deadline = input.deadline_at.unwrap_or_else(|| {
            (now + Duration::days(7)).to_rfc3339_opts(SecondsFormat::Secs, true)
        });
        terms.payment_deadline(Some(PaymentDeadline::At {
            timestamp: deadline,
        }))
    };
    // rc62 apps show "waiting for updated private payment details" until the issuer's Private Payment List reached them: the list goes
    // out with the request, with the regtest endpoint of the fixture as its one private receiving detail.
    app.sdk
        .enqueue_private_payment_list_with_receiving_details(
            peer.clone(),
            vec![paykit_sdk::PrivateReceivingDetail {
                identifier: ENDPOINT.into(),
                payload: json!({ "value": app.address }).to_string(),
            }],
        )
        .await?;
    let mut record = app
        .sdk
        .propose_payment_request(peer.clone(), terms.build()?)
        .await?;
    if let Some(fixed) = fixed_id {
        // the SDK names a proposal itself; the queued message is given the id the journey names before it goes out
        PaymentRequestId::new(fixed.clone())?;
        let generated = record.payment_request_id.clone();
        let counterparty = peer.clone();
        let replacement = fixed.clone();
        app.storage
            .transaction(move |tx| {
                let mut message = tx
                    .queued_outbound_private_messages(&counterparty)
                    .into_iter()
                    .find(|message| message.raw_json.contains(&generated))
                    .ok_or_else(|| paykit_sdk::PaykitSdkError::Protocol {
                        context: "fixture proposal not queued".into(),
                        source: None,
                    })?;
                message.raw_json = message.raw_json.replace(&generated, &replacement);
                tx.save_outbound_private_message(message)
            })
            .await?;
        record.payment_request_id = fixed;
    }
    let sent = app
        .sdk
        .process_outbound_private_messages(peer)
        .await?;
    if !sent.failed.is_empty() || sent.sent.len() < 2 {
        return Err(anyhow!(
            "Payment Request delivery failed: {} failed, {} sent (the private payment list and the request)",
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
    let peer = input.parsed()?;
    Ok(Json(
        json!({ "records": app.sdk.payment_requests_with(&peer).await? }),
    ))
}

async fn act(State(app): State<Arc<App>>, action: &'static str, input: RecordInput) -> ApiResult {
    let _guard = app.operation.lock().await;
    let peer = input.peer.parsed()?;
    let _ = app
        .sdk
        .receive_private_messages(peer.clone())
        .await?;
    let id = PaymentRequestId::new(input.payment_request_id)?;
    let record = match action {
        "accept" => {
            app.sdk.claim_payment_request_for_execution(peer.clone(), &id).await?;
            app.sdk
                .accept_payment_request(peer.clone(), &id)
                .await?
        }
        "reject" => {
            app.sdk
                .reject_payment_request(peer.clone(), &id, None)
                .await?
        }
        "cancel" => {
            app.sdk.claim_payment_request_for_execution(peer.clone(), &id).await?;
            app.sdk
                .cancel_payment_request(peer.clone(), &id, None)
                .await?
        }
        _ => unreachable!(),
    };
    let sent = app
        .sdk
        .process_outbound_private_messages(peer)
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
    let peer = input.record.peer.parsed()?;
    let id = PaymentRequestId::new(input.record.payment_request_id)?;
    let _ = app
        .sdk
        .receive_private_messages(peer.clone())
        .await?;
    let record = app
        .sdk
        .payment_requests_with(&peer)
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
            &id,
            period,
            PaykitAppId::new("bitkit")?,
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
    let sent = app.sdk.process_outbound_private_messages(peer).await;
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

async fn withdraw(State(app): State<Arc<App>>, Json(input): Json<Peer>) -> ApiResult {
 let _guard = app.operation.lock().await;
 let peer = input.parsed()?;
 let report = app.sdk.sync_private_payment_lists_with_reservations_and_process_outbound(vec![paykit_sdk::PrivatePaymentListReservationUpdate {counterparty: peer, reservations: vec![]}], false).await?;
 Ok(Json(serde_json::to_value(report)?))
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
        .route("/withdraw", post(withdraw))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    axum::serve(listener, router).await?;
    Ok(())
}
