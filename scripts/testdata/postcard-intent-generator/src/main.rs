//! Wire schema from paykit-server caf2b6d application/semantic_intent.rs.
//! metadata is the JSON string produced by its json_map_as_string serializer.
//! Rates are empty for this unquoted-Bitcoin golden; no production secrets.
use serde::Deserialize;
use serde::Serialize;
use std::{collections::BTreeMap, io::{self, Read}};

#[derive(Deserialize, Serialize)]
struct Intent {
    version: u8,
    reader_pubky: String,
    app_id: String,
    operation: Operation,
}
#[derive(Deserialize, Serialize)]
enum Operation {
    PaymentRequestProposal { terms: Terms },
    PaymentRequestCancellation { payment_request_id: String },
}
#[derive(Deserialize, Serialize)]
struct Terms {
    amount: String,
    asset: String,
    rates: Vec<()>,
    payment_reference: String,
    proposal_expires_at: Option<String>,
    payment_deadline: Option<String>,
    accepted_endpoint_identifiers: Vec<String>,
    payment_endpoints: BTreeMap<String, String>,
    metadata: String,
}
fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let intent: Intent = serde_json::from_str(&input).unwrap();
    for byte in postcard::to_allocvec(&intent).unwrap() { print!("{byte:02x}"); }
    println!();
}
