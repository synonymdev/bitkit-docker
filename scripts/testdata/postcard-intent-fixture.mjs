// Independent test writer for caf2b6d DeliveryIntentV1; checked against Rust Postcard.
import { readFileSync } from 'node:fs';
const intent = JSON.parse(readFileSync(0, 'utf8'));
const chunks = [];
function uint(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Unsigned integer required');
  do { const byte = value % 128; value = Math.floor(value / 128); chunks.push(Buffer.from([byte | (value ? 128 : 0)])); } while (value);
}
function string(value) { const bytes = Buffer.from(value, 'utf8'); uint(bytes.length); chunks.push(bytes); }
function option(value) { uint(value == null ? 0 : 1); if (value != null) string(value); }
uint(intent.version);
string(intent.reader_pubky);
string(intent.app_id);
uint(0); // PaymentRequestProposal
const terms = intent.operation.PaymentRequestProposal.terms;
string(terms.amount);
string(terms.asset);
uint(terms.rates.length);
if (terms.rates.length) throw new Error('Golden fixture covers unquoted Bitcoin only');
string(terms.payment_reference);
option(terms.proposal_expires_at);
option(terms.payment_deadline);
uint(terms.accepted_endpoint_identifiers.length);
terms.accepted_endpoint_identifiers.forEach(string);
const endpoints = Object.entries(terms.payment_endpoints).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
uint(endpoints.length);
for (const [identifier, value] of endpoints) { string(identifier); string(value); }
string(terms.metadata);
process.stdout.write(Buffer.concat(chunks).toString('hex'));
