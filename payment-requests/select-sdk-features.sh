#!/bin/sh
# Select only a known API from the exact dependency checkout already resolved by Cargo.
set -eu
if [ "$#" != 1 ] || [ ! -f "$1" ]; then
  echo 'Expected exactly one resolved Paykit SDK payment_requests.rs source' >&2
  exit 1
fi
signature=$(sed -n '/pub async fn accept_payment_request(/,/-> Result/p' "$1" | tr -d '[:space:]')
case "$signature" in
  'pubasyncfnaccept_payment_request(&self,counterparty:PubkyPublicKey,payment_request_id:&PaymentRequestId,)->Result<PaymentRequestRecord>{')
    # rc65: the existing two-argument API remains the default Cargo build.
    ;;
  'pubasyncfnaccept_payment_request(&self,counterparty:PubkyPublicKey,payment_request_id:&PaymentRequestId,expected_proposal_stream_item_id:u64,)->Result<PaymentRequestRecord>{')
    printf '%s\n' '--features=versioned-payment-request-acceptance'
    ;;
  *)
    echo 'Unsupported Paykit SDK acceptance API; update the fixture explicitly' >&2
    exit 1
    ;;
esac
