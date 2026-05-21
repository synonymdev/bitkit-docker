# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Show ready-to-copy settle and cancel commands in `holdinvoice` output
- Simplify LND funding step in README to a single command instead of clipboard-based two-step flow

### Fixed
- Validate LNURL-withdraw callback invoices by millisatoshis (`num_msat`) to preserve msat precision for min/max range checks
- Preserve LNURL-pay invoice millisatoshi precision by creating invoices with LND `value_msat` instead of truncating callback amounts to sats

### Added
- Homegate Docker Compose service with dedicated PostgreSQL storage, local homeserver admin mock, and README setup flow
- Trezor User Env Docker service and `scripts/trezor-emulator` helper for quickly smoke-testing Bitkit app Trezor PRs
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
