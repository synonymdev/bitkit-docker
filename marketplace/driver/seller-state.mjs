// Native wallets supply their own identities and spending keys. A local native
// seller must not depend on seeding the fixture's separate headless seller.
export function requireFixture(fixture, staging = false) {
  if (staging ? !fixture?.bitkit_seller : !(fixture?.seller || fixture?.bitkit_seller)) {
    throw new Error(staging
      ? 'no Bitkit seller yet; run: ./shop-mixed seller-auth'
      : 'no seller yet; approve ./pubky-marketplace seller-auth for a Bitkit wallet, or seed a headless seller');
  }
  return fixture;
}

export function selectSeller(fixture, which) {
  if (which === 'headless') {
    if (!fixture.seller) throw new Error('no headless seller; run: ./pubky-marketplace seed, or select --seller bitkit');
    return fixture.seller;
  }
  const seller = fixture.bitkit_seller;
  if (!seller) throw new Error('no Bitkit seller; run: ./pubky-marketplace seller-auth');
  if (which === 'bitkit' || which === seller.pubky) return seller;
  throw new Error(`--seller must be headless, bitkit or ${seller.pubky}`);
}

export function rememberBitkitSeller(fixture, approved, setupReady, now) {
  const previous = fixture.bitkit_seller?.pubky === approved.pubky ? fixture.bitkit_seller : {};
  return {...fixture, bitkit_seller: {
    ...previous, ...approved, marketplace_grant_at: now,
    ...(setupReady ? {setup_completed_at: previous.setup_completed_at ?? now} : {}),
  }};
}
