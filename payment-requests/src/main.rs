//! Disposable rc74 Paykit peer for Bitkit regtest journeys.
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
    LinkedPeerState, PaykitApp, PaykitAppCapabilities, PaykitAppId, PaykitSdk, PaykitSdkConfig,
    PaymentAdapter, PaymentRequestLifecycleState, PubkyLocalSecretKey, PubkyPublicKey,
    PubkySessionAccess, PubkySessionBootstrap, PubkySessionProvider, PubkySharedStateStorage,
    StorageAdapter, PAYKIT_AUTHORIZER_SESSION_CAPABILITIES,
};
use pubky::{Keypair, Pubky};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;

const HOMESERVER: &str = "pubky8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo";
const ENDPOINT: &str = "btc-regtest-p2wpkh";
// the identifier Bitkit reads an LNURL-pay endpoint from (`MethodId.Lnurl`)
const LNURL_ENDPOINT: &str = "btc-lightning-lnurl";

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
    // `/endpoints` withhold: no public endpoint and an empty private payment list, so an app cannot resolve the request's endpoint
    withheld: Mutex<bool>,
    // the LNURL-pay endpoint the last `/request` named (`lnurl`): offered beside the regtest address from then on
    lnurl: std::sync::Mutex<Option<String>>,
}

impl App {
    /// The receiving details the issuer offers: none while its endpoints are withheld.
    fn private_details(&self, withheld: bool) -> Vec<paykit_sdk::PrivateReceivingDetail> {
        if withheld {
            return vec![];
        }
        let mut details = vec![paykit_sdk::PrivateReceivingDetail {
            identifier: ENDPOINT.into(),
            payload: json!({ "value": self.address }).to_string(),
        }];
        if let Some(lnurl) = self.lnurl.lock().unwrap().clone() {
            details.push(paykit_sdk::PrivateReceivingDetail {
                identifier: LNURL_ENDPOINT.into(),
                payload: json!({ "value": lnurl }).to_string(),
            });
        }
        details
    }
}

#[derive(Deserialize)]
struct Peer {
    peer_pubky: String,
    // Kept in the HTTP contract; rc74 links are identity-wide.
    #[serde(rename = "peer_path")]
    _peer_path: String,
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
    // an LNURL-pay string (`GET :23010/generate/pay` of the lane's LNURL fixture): the request then accepts only `btc-lightning-lnurl`,
    // which the private payment list sent with it offers (bitkit-android#1401 J19, 7 Oct)
    lnurl: Option<String>,
    // when the proposal itself expires (the acceptance deadline), apart from the payment deadline
    proposal_expires_at: Option<String>,
}

#[derive(Deserialize)]
struct RecordInput {
    #[serde(flatten)]
    peer: Peer,
    payment_request_id: String,
    // Optional for normal fixture preparation; supply the reviewed ID to probe stale approval.
    expected_proposal_stream_item_id: Option<u64>,
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

/// Mines to this wallet until it can send `sats` and a fee: a seat's chain starts at one block, whose coinbase is immature, so
/// `/pay` failed with bitcoind's "Insufficient funds" (bitkit-android#1401 J14, 7 Oct). Regtest halves the subsidy every 150 blocks,
/// so a long chain may need more than one round of 101 blocks.
async fn fund(sats: u64) -> Result<()> {
    let needed = sats as f64 / 100_000_000.0 + 0.001;
    for _ in 0..5 {
        if rpc("getbalance", json!([])).await?.as_f64().unwrap_or(0.0) >= needed {
            return Ok(());
        }
        let address = rpc("getnewaddress", json!(["", "bech32"])).await?;
        rpc("generatetoaddress", json!([101, address])).await?;
    }
    bail!("the fixture wallet holds less than {needed} BTC after mining 505 blocks")
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
            Err(error) => {
                return Err(error.context(format!("{what} still failing after {timeout}s")))
            }
        }
    }
}

async fn setup() -> Result<App> {
    let role = env::var("FIXTURE_ROLE").context("FIXTURE_ROLE is required")?;
    // the issuer contract of the Bitkit journeys: the fixture issuer's App ID is `paykit-server`
    let default_app_id = if role == "fixture-issuer" {
        "paykit-server"
    } else {
        "qa-fixture"
    };
    let receiver_path =
        PaykitAppId::new(env::var("APP_ID").unwrap_or_else(|_| default_app_id.into()))?;
    let pubky = Pubky::testnet()?;
    let bootstrap = PubkySessionBootstrap::with_pubky(pubky, "bitkit-docker.fixture")?
        .with_auth_relay("http://localhost:15412/inbox")?;
    let config = PaykitSdkConfig::new(receiver_path.clone())?;
    let homeserver = PubkyPublicKey::from_raw_or_app_key(HOMESERVER)?;
    // A new identity per attempt: a failed sign-up must not leave the retry with a half-created account.
    let signed_up = retry("sign-up on the local homeserver", || async {
        let phrase_file = env::var("MNEMONIC_FILE").ok();
        let secret = if let Some(ref file) = phrase_file {
            PubkyLocalSecretKey::from_bip39_mnemonic(std::fs::read_to_string(file)?.trim())?
        } else {
            PubkyLocalSecretKey::new(Keypair::random().secret_key())
        };
        if phrase_file.is_some() {
            return Ok(bootstrap
                .sign_in(&secret, PAYKIT_AUTHORIZER_SESSION_CAPABILITIES)
                .await?);
        }
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
    if let Ok(expected) = env::var("EXPECTED_PUBKY") {
        if signed_up.public_key != PubkyPublicKey::from_raw_or_app_key(&expected)? {
            bail!("imported disposable identity does not match EXPECTED_PUBKY");
        }
    }
    let provider = SessionProvider(Arc::new(Mutex::new(Some(signed_up.access))));
    let storage = PubkySharedStateStorage::new(provider.clone());
    let sdk = PaykitSdk::new(storage.clone(), provider, FixturePaymentAdapter, config);
    sdk.initialize().await?;
    let imported = env::var("MNEMONIC_FILE").is_ok();
    if !imported {
        sdk.publish_paykit_noise_key_authorization().await?;
        retry("receiver marker publication", || async {
            Ok(sdk
                .publish_paykit_app(PaykitApp::new(
                    "QA Fixture",
                    PaykitAppCapabilities {
                        private_payments: true,
                        payment_requests: true,
                        receipts: false,
                        outgoing_payments: role == "rc56-peer",
                    },
                )?)
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
                .sync_public_endpoints_with_receiving_details(vec![
                    paykit_sdk::PublicReceivingDetail {
                        identifier: ENDPOINT.into(),
                        payload: endpoint_payload.clone(),
                    },
                ])
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
        withheld: Mutex::new(false),
        lnurl: std::sync::Mutex::new(None),
    })
}

async fn info(State(app): State<Arc<App>>) -> ApiResult {
    // The Dockerfile can follow an app's SDK pin; report what the image actually built.
    let sdk_revision = std::fs::read_to_string("/usr/local/share/paykit-rs-rev")
        .unwrap_or_else(|_| "03d4f05721e92d3944cb4d5af4b2c98c4390a5a8".into());
    Ok(Json(json!({
        "status": "ready", "role": app.role, "pubky": app.pubky.to_app_key(),
        "receiver_path": app.receiver_path.as_str(), "endpoint": ENDPOINT,
        "address": app.address, "lnurl": app.lnurl.lock().unwrap().clone(),
        "paykit_rs_rev": sdk_revision.trim(),
        "controls": ["replace", "forget", "reset-link"],
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
    let received = app.sdk.receive_private_messages(peer.clone()).await?;
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
        vec![PaymentEndpointIdentifier::new(if input.lnurl.is_some() {
            LNURL_ENDPOINT
        } else {
            ENDPOINT
        })?],
    )
    .proposal_expires_at(input.proposal_expires_at);
    if let Some(lnurl) = input.lnurl {
        if !lnurl.to_ascii_lowercase().starts_with("lnurl1") {
            return Err(anyhow!("lnurl must be a bech32 LNURL (lnurl1...)").into());
        }
        *app.lnurl.lock().unwrap() = Some(lnurl);
    }
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
    // While `/endpoints` withholds them, the list goes out empty: the request names an endpoint the app cannot resolve.
    let withheld = *app.withheld.lock().await;
    app.sdk
        .enqueue_private_payment_list_with_receiving_details(
            peer.clone(),
            app.private_details(withheld),
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
                message.raw_json = rename_request(&message.raw_json, &generated, &replacement)
                    .map_err(|error| paykit_sdk::PaykitSdkError::Protocol {
                        context: error.to_string(),
                        source: None,
                    })?;
                tx.save_outbound_private_message(message)
            })
            .await?;
        record.payment_request_id = fixed;
    }
    let sent = app.sdk.process_outbound_private_messages(peer).await?;
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
        "deadline": record.terms.as_ref().and_then(|terms| terms.payment_deadline.as_ref()),
        "endpoints_withheld": withheld }),
    ))
}

// Change the protocol field only: a reference or metadata may contain the generated UUID too.
fn rename_request(raw: &str, expected: &str, replacement: &str) -> Result<String> {
    PaymentRequestId::new(replacement.to_owned())?;
    let mut value: Value = serde_json::from_str(raw)?;
    if value["payment_request_id"] != expected {
        bail!("queued proposal has another Payment Request ID");
    }
    value["payment_request_id"] = json!(replacement);
    Ok(serde_json::to_string(&value)?)
}

/// Resend the original terms under the same request ID with a new Event ID.
/// The receiver must forget the old peer history first, or the SDK records a conflict.
async fn replace(State(app): State<Arc<App>>, Json(input): Json<RecordInput>) -> ApiResult {
    let _guard = app.operation.lock().await;
    let peer = input.peer.parsed()?;
    let id = PaymentRequestId::new(input.payment_request_id)?;
    let original = app
        .storage
        .transaction(|tx| {
            Ok(tx
                .outbound_private_messages(&peer)
                .into_iter()
                .find(|message| {
                    message.kind == "paykit.payment_request"
                        && serde_json::from_str::<Value>(&message.raw_json)
                            .is_ok_and(|value| value["payment_request_id"] == id.as_str())
                }))
        })
        .await?
        .context("unknown issued Payment Request")?;
    let message = paykit_lib::PrivateApplicationMessage {
        version: Some(1),
        kind: Some(original.kind),
        app_id: Some(original.app_id.as_str().to_owned()),
        raw_json: original.raw_json,
    };
    let parsed = paykit_lib::parse_payment_request_event_message(&message)
        .context("original is not a Payment Request")?;
    let Some(paykit_lib::PaymentRequestEvent::Request(request)) = parsed.parsed_event() else {
        return Err(anyhow!("original proposal is invalid").into());
    };
    let terms = request.request().clone();
    let original_event = request.event_id().as_str().to_owned();
    let queued = app.sdk.propose_payment_request(peer.clone(), terms).await?;
    let generated = queued.payment_request_id;
    let replacement = id.as_str().to_owned();
    app.storage
        .transaction(|tx| {
            let mut message = tx
                .queued_outbound_private_messages(&peer)
                .into_iter()
                .find(|message| {
                    serde_json::from_str::<Value>(&message.raw_json)
                        .is_ok_and(|value| value["payment_request_id"] == generated)
                })
                .ok_or_else(|| paykit_sdk::PaykitSdkError::Protocol {
                    context: "replacement not queued".into(),
                    source: None,
                })?;
            message.raw_json = rename_request(&message.raw_json, &generated, &replacement)
                .map_err(|error| paykit_sdk::PaykitSdkError::Protocol {
                    context: error.to_string(),
                    source: None,
                })?;
            tx.save_outbound_private_message(message)
        })
        .await?;
    let sent = app.sdk.process_outbound_private_messages(peer).await?;
    if !sent.failed.is_empty() || sent.sent.is_empty() {
        return Err(anyhow!("replacement delivery failed").into());
    }
    Ok(Json(json!({ "payment_request_id": id.as_str(),
        "original_event_id": original_event, "replacement_event_id": queued.proposal_event_id,
        "sent": sent.sent.len() })))
}

/// Controlled reset through the SDK's public API, preserving monotonic stream IDs.
/// An imported disposable app identity can use this while its review sheet remains open.
async fn forget(State(app): State<Arc<App>>, Json(input): Json<Peer>) -> ApiResult {
    let _guard = app.operation.lock().await;
    let peer = input.parsed()?;
    app.sdk.block_peer(peer.clone()).await?;
    app.sdk.forget_peer(peer.clone()).await?;
    let record = app.sdk.unblock_peer(peer).await?;
    Ok(Json(serde_json::to_value(record)?))
}

/// Drop only the transport link on the issuer before a fresh handshake.
/// Its original proposal and delivery confirmation stay in shared history.
async fn reset_link(State(app): State<Arc<App>>, Json(input): Json<Peer>) -> ApiResult {
    let _guard = app.operation.lock().await;
    let peer = input.parsed()?;
    app.sdk.block_peer(peer.clone()).await?;
    let record = app.sdk.unblock_peer(peer).await?;
    Ok(Json(serde_json::to_value(record)?))
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
    let _ = app.sdk.receive_private_messages(peer.clone()).await?;
    let id = PaymentRequestId::new(input.payment_request_id)?;
    let record = match action {
        "accept" => {
            let reviewed = match input.expected_proposal_stream_item_id {
                Some(id) => id,
                None => app
                    .sdk
                    .payment_requests_with(&peer)
                    .await?
                    .into_iter()
                    .find(|record| record.payment_request_id == id.as_str())
                    .and_then(|record| record.proposal_stream_item_id)
                    .context("request has no proposal stream item ID")?,
            };
            app.sdk
                .claim_payment_request_for_execution(peer.clone(), &id)
                .await?;
            app.sdk
                .accept_payment_request(peer.clone(), &id, reviewed)
                .await?
        }
        "reject" => {
            app.sdk
                .reject_payment_request(peer.clone(), &id, None)
                .await?
        }
        "cancel" => {
            app.sdk
                .claim_payment_request_for_execution(peer.clone(), &id)
                .await?;
            app.sdk
                .cancel_payment_request(peer.clone(), &id, None)
                .await?
        }
        _ => unreachable!(),
    };
    let sent = app.sdk.process_outbound_private_messages(peer).await?;
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
    let _ = app.sdk.receive_private_messages(peer.clone()).await?;
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
        fund(input.amount_sats).await?;
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
    let report = app
        .sdk
        .sync_private_payment_lists_with_reservations_and_process_outbound(
            vec![paykit_sdk::PrivatePaymentListReservationUpdate {
                counterparty: peer,
                reservations: vec![],
            }],
            false,
        )
        .await?;
    Ok(Json(serde_json::to_value(report)?))
}

#[derive(Deserialize)]
struct EndpointsInput {
    // `withhold` or `restore`
    action: String,
    // the peer whose private payment list follows the change; without one only the public endpoint changes
    #[serde(flatten)]
    peer: Option<Peer>,
}

async fn endpoints_state(State(app): State<Arc<App>>) -> ApiResult {
    Ok(Json(
        json!({ "withheld": *app.withheld.lock().await, "endpoint": ENDPOINT }),
    ))
}

/// Withholds or restores the issuer's payment endpoints: its public endpoint and, for the named peer, its private payment list.
async fn endpoints(State(app): State<Arc<App>>, Json(input): Json<EndpointsInput>) -> ApiResult {
    let _guard = app.operation.lock().await;
    let withheld = match input.action.as_str() {
        "withhold" => true,
        "restore" => false,
        other => return Err(anyhow!("action must be withhold or restore, not {other}").into()),
    };
    *app.withheld.lock().await = withheld;
    let public: Vec<paykit_sdk::PublicReceivingDetail> = app
        .private_details(withheld)
        .into_iter()
        .map(|detail| paykit_sdk::PublicReceivingDetail {
            identifier: detail.identifier,
            payload: detail.payload,
        })
        .collect();
    let published = app
        .sdk
        .sync_public_endpoints_with_receiving_details(public)
        .await?;
    let mut private = Value::Null;
    if let Some(peer) = input.peer {
        let peer = peer.parsed()?;
        app.sdk
            .enqueue_private_payment_list_with_receiving_details(
                peer.clone(),
                app.private_details(withheld),
            )
            .await?;
        let sent = app.sdk.process_outbound_private_messages(peer).await?;
        if !sent.failed.is_empty() || sent.sent.is_empty() {
            return Err(anyhow!(
                "private payment list delivery failed: {} failed, {} sent",
                sent.failed.len(),
                sent.sent.len()
            )
            .into());
        }
        private =
            json!({ "sent": sent.sent.len(), "entries": app.private_details(withheld).len() });
    }
    Ok(Json(json!({
        "withheld": withheld,
        "public": { "published": published.published.len(), "failed": published.failed.len() },
        "private_payment_list": private,
    })))
}

/// `paykit-key-authorization` (this binary under that name, in the marketplace driver's image): publishes the Paykit noise key
/// authorization of an identity the driver signed up, as a Bitkit wallet does in its own Paykit setup. Paykit Server rc65 checks it
/// before it accepts a setup claim. Reads `{"version":1,"creator_secret":"<base64url 32 bytes>"}` on stdin.
async fn publish_key_authorization() -> Result<()> {
    use base64::Engine;
    #[derive(Deserialize)]
    struct Input {
        version: u8,
        creator_secret: String,
    }
    let mut body = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut body)?;
    let input: Input = serde_json::from_str(&body)?;
    if input.version != 1 {
        bail!("unsupported input version");
    }
    let bytes: [u8; 32] = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(input.creator_secret.trim())?
        .try_into()
        .map_err(|_| anyhow!("creator_secret must be 32 bytes"))?;
    let secret = PubkyLocalSecretKey::new(bytes);
    let bootstrap = PubkySessionBootstrap::with_pubky(Pubky::testnet()?, "bitkit-docker.fixture")?
        .with_auth_relay("http://localhost:15412/inbox")?;
    let signed_in = bootstrap
        .sign_in(&secret, PAYKIT_AUTHORIZER_SESSION_CAPABILITIES)
        .await?;
    let pubky = signed_in.public_key.to_app_key();
    let provider = SessionProvider(Arc::new(Mutex::new(Some(signed_in.access))));
    let sdk = PaykitSdk::new(
        PubkySharedStateStorage::new(provider.clone()),
        provider,
        FixturePaymentAdapter,
        PaykitSdkConfig::new(PaykitAppId::new("qa-fixture")?)?,
    );
    sdk.initialize().await?;
    sdk.publish_paykit_noise_key_authorization().await?;
    println!("{}", json!({ "published": true, "pubky": pubky }));
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let invoked = env::args().next().unwrap_or_default();
    if invoked.ends_with("paykit-key-authorization") {
        return publish_key_authorization().await;
    }
    if env::args().nth(1).as_deref() == Some("--health") {
        let port = env::var("FIXTURE_PORT").unwrap_or_else(|_| "3002".into());
        reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/health"))
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await?
            .error_for_status()?;
        return Ok(());
    }
    let control = env::args().nth(1).as_deref() == Some("--control");
    if control && (env::var("MNEMONIC_FILE").is_err() || env::var("EXPECTED_PUBKY").is_err()) {
        bail!("--control requires MNEMONIC_FILE and EXPECTED_PUBKY for a disposable identity");
    }
    let app = Arc::new(setup().await?);
    if control {
        let mut body = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut body)?;
        let peer: Peer = serde_json::from_str(&body)?;
        let result = match env::args().nth(2).as_deref() {
            Some("forget") => forget(State(app.clone()), Json(peer)).await,
            Some("reset-link") => reset_link(State(app.clone()), Json(peer)).await,
            Some("link") => {
                link(
                    State(app.clone()),
                    Json(LinkInput {
                        peer,
                        mode: String::new(),
                    }),
                )
                .await
            }
            Some("sync") => sync(State(app.clone()), Json(peer)).await,
            Some("records") => records(State(app.clone()), Json(peer)).await,
            _ => bail!("--control action must be forget, reset-link, link, sync or records"),
        }
        .map_err(|error| error.0)?;
        println!(
            "{}",
            json!({"pubky": app.pubky.to_app_key(), "result": result.0})
        );
        return Ok(());
    }
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
        .route("/replace", post(replace))
        .route("/forget", post(forget))
        .route("/reset-link", post(reset_link))
        .route("/accept", post(accept))
        .route("/reject", post(reject))
        .route("/cancel", post(cancel))
        .route("/pay", post(pay))
        .route("/proof", post(proof))
        .route("/withdraw", post(withdraw))
        .route("/endpoints", get(endpoints_state).post(endpoints))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    axum::serve(listener, router).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_rename_preserves_reference_and_terms() {
        let old = "71300000-0000-4000-8000-000000000001";
        let new = "71300000-0000-4000-8000-000000000002";
        let raw = json!({"payment_request_id": old, "request": {"payment_reference": old}, "event_id": "unchanged"});
        let changed: Value =
            serde_json::from_str(&rename_request(&raw.to_string(), old, new).unwrap()).unwrap();
        assert_eq!(changed["payment_request_id"], new);
        assert_eq!(changed["request"], raw["request"]);
        assert_eq!(changed["event_id"], raw["event_id"]);
        assert!(rename_request(&raw.to_string(), new, old).is_err());
        assert!(rename_request(&raw.to_string(), old, "invalid").is_err());
    }
}
