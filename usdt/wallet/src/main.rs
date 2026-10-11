use anyhow::{bail, Context, Result};
use bitkitcore::{
    usdt_address, UsdtBackup, UsdtDepositClient, UsdtDepositNetwork, UsdtDestination, UsdtError,
    UsdtPaymentProof, UsdtPaymentProofBinding, UsdtWallet,
};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};

// Public fixture mnemonic, never a funded wallet. Apps use their own disposable test seeds.
const MNEMONIC: &str = "test test test test test test test test test test test junk";
const GATEWAY: &str = "http://127.0.0.1:23453/v1/usdt";
const CONTROL: &str = "http://127.0.0.1:23454";
struct Backup;
#[async_trait::async_trait]
impl UsdtBackup for Backup {
    async fn persist(&self, _snapshot: String) -> Result<(), UsdtError> {
        // The fixture tests Core execution; mobile backup scenarios use real staging VSS.
        Ok(())
    }
}
async fn control(method: &str, params: Value) -> Result<Value> {
    let result: Value = reqwest::Client::new()
        .post(CONTROL)
        .json(&json!({"jsonrpc":"2.0", "id":1, "method":method, "params":params}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    if result.get("error").is_some() {
        bail!("fixture command failed: {}", result["error"]);
    }
    Ok(result["result"].clone())
}
#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("address");
    // The fixture controller exists only on the local stack. Never accept an arbitrary RPC URL.
    let status = control("status", json!([])).await?;
    anyhow::ensure!(status["chainId"] == 42161, "wrong fixture chain");
    let passphrase = Some(format!(
        "bitkit-usdt-fixture-{}",
        std::env::var("USDT_WALLET_NAME").unwrap_or_else(|_| "sender".into())
    ));
    let address = usdt_address(MNEMONIC.into(), passphrase.clone())?;
    let state =
        PathBuf::from(std::env::var("USDT_WALLET_DIR").unwrap_or_else(|_| ".usdt/wallet".into()));
    std::fs::create_dir_all(&state)?;
    let wallet = UsdtWallet::new(
        address.clone(),
        state
            .join(format!("{address}.sqlite"))
            .to_string_lossy()
            .into(),
        format!("{GATEWAY}/chain-rpc"),
        format!("{GATEWAY}/rpc"),
        Some(format!("{GATEWAY}/bridges")),
        Arc::new(Backup),
    )?;
    let result = match command {
        "address" => json!({"address":address}),
        "balance" => json!({"address":address,"balance":wallet.balance().await?}),
        "quote" | "send" => {
            let recipient = args.get(1).context("send requires recipient and atomic amount")?;
            let amount: u64 = args.get(2).context("send requires atomic amount")?.parse()?;
            let destination = args.get(3).map(|s| serde_json::from_value::<UsdtDestination>(json!(s))).transpose()?.unwrap_or(UsdtDestination::Arbitrum);
            let quote = wallet.quote_transfer(recipient.clone(), amount, destination).await?;
            if command == "quote" {
                println!("{}", serde_json::to_string_pretty(&quote)?);
                return Ok(());
            }
            let transfer = wallet.send(quote.id.clone(), MNEMONIC.into(), passphrase.clone()).await?;
            json!({"quote":quote,"transfer":transfer})
        }
        "refresh" => {
            let id = args.get(1).context("refresh requires transfer ID")?;
            json!(wallet.refresh_transfers().await?.into_iter().find(|transfer| transfer.id == *id))
        }
        "history" => json!(wallet.history()?),
        "deposit" => {
            let client = UsdtDepositClient::new(address, format!("{GATEWAY}/deposits"))?;
            match args.get(1).map(String::as_str) {
                Some("receive") => {
                    let network: UsdtDepositNetwork = serde_json::from_value(json!(args.get(2).context("receive requires network")?))?;
                    let amount = args.get(3).context("receive requires atomic amount")?.parse()?;
                    let result = client.receive(network, amount, MNEMONIC.into(), passphrase).await?;
                    json!({"address":result.address,"recipient":result.recipient,"amount":result.amount,"estimated_received":result.estimated_received,"uri":result.uri})
                }
                Some("history") => {
                    let page = client.history(0, MNEMONIC.into(), passphrase).await?;
                    json!({"deposits": page.deposits.into_iter().map(|d|json!({"id":d.id,"status":d.status,"amount":d.amount,"refund_tx":d.refund_tx})).collect::<Vec<_>>(),"next_offset":page.next_offset})
                }
                Some("detail") => {
                    let d = client.detail(args.get(2).context("detail requires ID")?.clone(), 0, MNEMONIC.into(), passphrase).await?;
                    json!({"id":d.deposit.id,"status":d.deposit.status,"order":d.order.map(|o|json!({"status":o.status,"amount_out":o.amount_out,"destination_tx":o.destination_tx,"refund_tx":o.refund_tx}))})
                }
                Some("refund") => {
                    let network: UsdtDepositNetwork = serde_json::from_value(json!(args.get(4).context("refund requires network")?))?;
                    client.request_refund(args.get(2).context("refund requires ID")?.clone(), 0, args.get(3).context("refund requires address")?.clone(), network, MNEMONIC.into(), passphrase).await?;
                    json!({"status":"refund_requested"})
                }
                _ => bail!("deposit receive NETWORK ATOMIC_AMOUNT | history | detail ID | refund ID ADDRESS NETWORK"),
            }
        }
        "proof" => {
            let id = args.get(1).context("proof requires transfer ID and binding file")?;
            let binding = load(args.get(2).context("proof requires binding file")?)?;
            wallet.create_payment_proof(id.clone(), proof_binding(&binding)?, MNEMONIC.into(), passphrase).await?
                .map(|p| json!({"type":"erc20-transfer-eip712","chain_id":p.chain_id,"transaction_hash":p.transaction_hash,"receipt_log_index":p.receipt_log_index,"signature":p.signature}))
                .unwrap_or(Value::Null)
        }
        "verify" => {
            let binding = load(args.get(1).context("verify requires binding and proof files")?)?;
            let proof = load(args.get(2).context("verify requires proof file")?)?;
            let verified = wallet.verify_payment_proof(proof_binding(&binding)?, UsdtPaymentProof {
                chain_id: text(&proof,"chain_id")?, transaction_hash: text(&proof,"transaction_hash")?,
                receipt_log_index: text(&proof,"receipt_log_index")?, signature: text(&proof,"signature")?,
            }).await?;
            verified.map(|p| json!({"payment_id":p.payment_id,"transfer_id":p.transfer_id,"sender":p.sender,"recipient":p.recipient,"amount":p.amount,"timestamp":p.timestamp})).unwrap_or(Value::Null)
        }
        _ => bail!("use address, balance, quote/send RECIPIENT ATOMIC_AMOUNT [Destination], deposit, refresh ID, history, proof ID BINDING_FILE, or verify BINDING_FILE PROOF_FILE"),
    };
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

fn load(path: &str) -> Result<Value> {
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}
fn text(value: &Value, key: &str) -> Result<String> {
    Ok(value[key]
        .as_str()
        .with_context(|| format!("{key} must be a string"))?
        .into())
}
fn proof_binding(value: &Value) -> Result<UsdtPaymentProofBinding> {
    Ok(UsdtPaymentProofBinding {
        payer: text(value, "payer")?,
        payee: text(value, "payee")?,
        payment_app_id: text(value, "payment_app_id")?,
        payment_request_id: text(value, "payment_request_id")?,
        payment_reference: text(value, "payment_reference")?,
        payment_endpoint_identifier: text(value, "payment_endpoint_identifier")?,
        period_starts_at: text(value, "period_starts_at")?,
        period_ends_at: text(value, "period_ends_at")?,
        conversion_quote_id: text(value, "conversion_quote_id")?,
    })
}
