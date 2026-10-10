"use client";
// shop-order provisioning page (bitkit-docker, disclosed; never part of the Shop): it is copied into the Shop source only when
// ./shop-order fetch runs with SHOP_ORDER_PROVISIONING=1, at src/app/marketplace/shop-order-provision/page.tsx. The Shop's studio
// cannot author a digital Lock, so the seller publishes their own listing's next revision with the `digitalLock` that
// ./shop-order lock printed, through the Shop's normal path (schema.parse, then CommerceApplication.commitUpsertListing). That
// publish emits the service's listing.sync, which stores the seller-authored Lock snapshot prepare_locks requires. It writes no
// order and no payment, and refuses unless the signed-in user owns the listing.
import { useState } from 'react';
import { CommerceApplication } from '@/application/commerce/commerce';
import { commerceListingRecordSchema } from '@/libs/commerce/marketplace-records';
import { useAuthStore } from '@/stores/auth/auth.store';

export default function ShopOrderProvision() {
  const [listingId, setListingId] = useState('');
  const [lockJson, setLockJson] = useState('');
  const [output, setOutput] = useState('Seller-only: attach a digital Lock to your own listing. No order or payment is written.');

  async function run(publish: boolean) {
    try {
      const seller = useAuthStore.getState().currentUserPubky;
      if (!seller) throw new Error('sign in as the seller first');
      const current = await CommerceApplication.getOrFetchListing(seller, listingId.trim());
      if (current.ownerPubky !== seller || current.listingId !== listingId.trim()) throw new Error('not your listing');
      if (!publish) {
        setOutput(JSON.stringify(current, null, 2));
        return;
      }
      const digitalLock = JSON.parse(lockJson);
      if (!String(digitalLock.policyUri ?? '').startsWith(`pubky://${seller}/`)) throw new Error('the Lock is not under your pubky');
      if (current.digitalLock?.policyUri === digitalLock.policyUri) throw new Error('this Lock is already published');
      const next = commerceListingRecordSchema.parse({
        ...current,
        digitalLock,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      const result = await CommerceApplication.commitUpsertListing(next);
      setOutput(JSON.stringify({ record: next, result }, null, 2));
    } catch (error) {
      setOutput(String(error));
    }
  }

  return (
    <main style={{ padding: 24, display: 'grid', gap: 12, maxWidth: 720 }}>
      <h1>shop-order provisioning (local test setup)</h1>
      <input placeholder="listing id" value={listingId} onChange={(event) => setListingId(event.target.value)} />
      <textarea placeholder="digitalLock JSON from ./shop-order lock" rows={8} value={lockJson}
        onChange={(event) => setLockJson(event.target.value)} />
      <div style={{ display: 'flex', gap: 12 }}>
        <button onClick={() => run(false)}>Read listing</button>
        <button onClick={() => run(true)}>Publish next revision with the Lock</button>
      </div>
      <pre style={{ whiteSpace: 'pre-wrap' }}>{output}</pre>
    </main>
  );
}
