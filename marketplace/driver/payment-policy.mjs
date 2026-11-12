// Keep the criterion and signed invoice request on the same selected schema.
export function windowFields(policy) {
  if (policy === 'legacy') return {};
  if (policy === 'payment-window-hours') return { payment_in: 24 };
  throw new Error(`Unsupported marketplace lock policy: ${policy}`);
}

export function paymentParams(seller, sats, policy) {
  return { recipient_pubky: seller, amount: String(sats), asset: 'BTC', ...windowFields(policy) };
}

export function invoiceBody(bundleId, lockResource, reader, policy) {
  return { bundle_id: bundleId, lock_resource: lockResource, reader, ...windowFields(policy) };
}
