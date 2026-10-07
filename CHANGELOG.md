# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Rebuild the Paykit fixtures on the paykit-rs version a Bitkit pull request pins with `scripts/follow-app-paykit`
- Withhold and restore the payment request issuer's endpoints with `POST /endpoints`, so a journey can make the app's request resolution fail and recover
- Route the apps' homeserver traffic through `homeserver-proxy`, whose control port (6298) delays or fails one identity's homeserver requests by path
- Hold LNURL-pay fixture callbacks with a `delay` mode, issue real invoices of the project's LND, and give a wallet a funded channel to it through LNURL-channel
- Issue payment requests payable through an LNURL-pay endpoint, with a separate proposal expiry

### Changed
- Move the payment request fixture peers to paykit-rs rc65 on Pubky 0.14.0, the SDK current Bitkit builds pin (the `fixture-issuer` and `rc56-peer` service names stay)
- Move the marketplace fixture to the Pubky 0.14.0 homeserver, which grants the `LOCK` write locks current Bitkit builds take, with Paykit Server `0ffd4da` (pubky/paykit-server#46, paykit-rs rc65, locks-core rc8) and the driver on `@synonymdev/pubky` 0.14.0
- Show ready-to-copy settle and cancel commands in `holdinvoice` output
- Simplify LND funding step in README to a single command instead of clipboard-based two-step flow

### Fixed
- Fund the payment request issuer's wallet before `/pay`, which failed with insufficient funds on a fresh regtest chain
- Clear stale X display locks in `scripts/trezor-emulator` before starting the emulator, fixing `RuntimeError('Emulator process died')` caused by Xvfb refusing to start over a leftover `/tmp/.X<n>-lock`
- Validate LNURL-withdraw callback invoices by millisatoshis (`num_msat`) to preserve msat precision for min/max range checks
- Preserve LNURL-pay invoice millisatoshi precision by creating invoices with LND `value_msat` instead of truncating callback amounts to sats

### Added
- Add an optional deterministic Trezor emulator and Bridge fixture for isolated regtest wallet projects.
- Add an opt-in LNURL-pay regtest fixture with switchable invoice callback errors for payment retry journeys
- Add a `vss` compose profile that starts the VSS server and its own database on port 5050 for wallet backup tests
- Add Pubky marketplace test fixture behind the `marketplace` compose profile: Pubky testnet, Paykit Server `722ef268` built from pinned source, and the `pubky-marketplace` driver CLI (`up`, `seed`, `purchase`, `mine`, `verify`, `seller-auth`) for the Bitkit marketplace wallet journey with a headless or Bitkit-approved seller; see `docs/pubky-marketplace.md`
- Add opt-in rc56 Payment Request fixture services for linked-peer and deadline-history wallet journeys
- Homegate Docker Compose service with dedicated PostgreSQL storage, local homeserver admin mock, and README setup flow
- Repo-managed Trezor User Env Docker service and `scripts/trezor-emulator` helper for quickly smoke-testing Bitkit app Trezor PRs
- Support `amount_msat` query param in `/generate/bolt11` endpoint for sub-sat precision invoices
- `bolt11` command in `bitcoin-cli` for creating regular Lightning invoices (supports `--msat` and `-m` memo)
- LND hold invoice commands in `bitcoin-cli`: `holdinvoice`, `settleinvoice`, `cancelinvoice`
- LND `getinfo` command in `bitcoin-cli` for connectivity debugging
- `.vscode/` to `.gitignore`
- Reorganized README Development section with `bitcoin-cli` command reference
- BIP21 URI decoding support in the `/decode` page
  - Parses on-chain Bitcoin addresses with parameters (amount, label, message)
  - Automatically extracts and decodes embedded Lightning invoices from `lightning` parameter
  - Shows both on-chain and lightning details in a unified output
- Auto-detection of input types (BOLT11, LNURL, BIP21)
- New `/decode/auto` API endpoint with automatic type detection
- New `/decode/bip21` API endpoint for direct BIP21 parsing
- Real-time input type indicator in the decode UI
- Enhanced BOLT11 output with additional fields matching lightningdecoder.com:
  - `prefix` (lnbc, lnbcrt, lntb, lntbs)
  - `chain` (network name)
  - `recoveryFlag`
  - `signatureHex`
  - `timeExpireDate` and `timeExpireDateString`
  - Detailed `routingInfo` with pubKey, shortChannelId, feeBaseMsat, cltvExpiryDelta
  - `unknownTags` with tagCode and tagWords
- CHANGELOG.md for tracking project changes
- CLAUDE.md with AI agent guidelines and changelog maintenance rules

### Changed
- Redesigned `/decode` page UI: replaced tab-based navigation with single input field and button group
- Updated page title to "Lightning & Bitcoin Decoder" to reflect broader functionality
- Simplified user flow: paste any supported format and click "Decode"
- "LNURL Encode" is now a separate button alongside "Decode"

### Removed
- Tab-based navigation on the decode page (Lightning Invoice, LNURL Decode, LNURL Encode tabs)

---

## [1.0.0] - Initial Release

### Added
- LNURL-withdraw support with configurable min/max amounts
- LNURL-pay support
- LNURL-auth support with JWT token generation
- LNURL-channel support
- Lightning Address support (`.well-known/lnurlp/:username`)
- BOLT11 invoice generation via LND
- QR code generation for all LNURL types
- Interactive generator UI at `/generate`
- Interactive decoder UI at `/decode`
- Lightning invoice (BOLT11) decoding
- LNURL encode/decode functionality
- Health check endpoint at `/health`
- Admin endpoints for payments, withdrawals, channels, and sessions
- Dark/light theme support based on OS preference
- Vercel/Geist-inspired design system
