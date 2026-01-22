# Claude Code Guidelines for Bitkit Docker

This file provides guidance to AI agents like Claude Code/Cursor/Copilot when working with code in this repository.

## Project Overview

Bitkit Docker is a complete Docker-based development environment for Bitcoin and Lightning Network development. It provides:

- **Bitcoin Core** (regtest) - Local Bitcoin node
- **LND** (Lightning Network Daemon) - Lightning node
- **Electrum Server** - Electrum protocol server
- **LNURL Server** - Main web application for LNURL protocols
- **VSS Server** - Versioned Storage Service for wallet backup

## Repository Structure

```
bitkit-docker/
├── docker-compose.yml      # Main Docker orchestration
├── bitcoin-cli             # Helper script for Bitcoin CLI commands
├── CHANGELOG.md            # Project changelog (MUST be maintained)
├── CLAUDE.md               # This file - AI agent guidelines
├── lnurl-server/           # LNURL server application (Node.js/Express)
│   ├── server.js           # Entry point
│   ├── routes/             # Express route handlers
│   │   ├── decoder.js      # /decode endpoints (BOLT11, LNURL, BIP21)
│   │   ├── generator.js    # /generate endpoints
│   │   └── admin.js        # Admin API endpoints
│   ├── templates.js        # HTML templates (Vercel-style design)
│   ├── services/           # Bitcoin and LND service integrations
│   ├── middleware/         # Express middleware
│   └── utils/              # Utility functions
├── lnd/                    # LND configuration and data
├── vss-server/             # VSS server (git submodule)
└── sql/                    # Database schemas
```

## Development Guidelines

### Code Style

- Use CommonJS modules (`require`/`module.exports`)
- Use Express.js patterns for routes
- Use `asyncHandler` wrapper for async route handlers
- Follow Vercel/Geist design system for UI components

### Templates (`lnurl-server/templates.js`)

- Use existing helper functions: `mainLayout`, `header`, `container`, `card`, `endpoint`
- CSS uses CSS custom properties (design tokens)
- Support both light and dark themes via `data-theme` attribute
- Inline all styles and scripts in templates

### API Patterns

- Routes use descriptive paths: `/`, `/generate`, `/decode`, `/health`
- Return JSON for API endpoints with `{ success: true/false, ... }`
- Return HTML for UI pages
- Use proper HTTP status codes (400 for bad requests, 404 for not found)
- Log operations using the `Logger` utility

### Error Handling

- Wrap async handlers with `asyncHandler` from middleware
- Return descriptive error messages in JSON responses
- Log errors with context using `Logger.error()`

---

## Changelog Maintenance

**CRITICAL RULE**: When making any changes to this project, you MUST update `CHANGELOG.md`.

### How to Update the Changelog

1. Add changes under the `[Unreleased]` section
2. Use the appropriate category:
   - `Added` - New features
   - `Changed` - Changes to existing functionality
   - `Deprecated` - Features that will be removed
   - `Removed` - Removed features
   - `Fixed` - Bug fixes
   - `Security` - Security improvements

3. Write entries in imperative mood ("Add feature" not "Added feature")
4. Include relevant file paths or endpoints when helpful
5. Group related changes together

### Example Changelog Entry

```markdown
## [Unreleased]

### Added
- New `/api/widget` endpoint for widget management
- Support for custom themes in the generator page

### Fixed
- Invoice decoding error when amount is null
```

---

## Common Tasks

### Adding a New Route

1. Create route file in `lnurl-server/routes/`
2. Register in `lnurl-server/server.js`
3. Add UI template function in `lnurl-server/templates.js` if needed
4. **Update CHANGELOG.md**

### Modifying the UI

1. Edit relevant function in `lnurl-server/templates.js`
2. Follow existing CSS patterns (use CSS custom properties)
3. Test in both light and dark modes
4. **Update CHANGELOG.md**

### Adding a New Feature

1. Plan the backend routes and frontend UI
2. Implement backend first (routes, services)
3. Add frontend (templates)
4. Update README.md if user-facing
5. **Update CHANGELOG.md**

---

## Testing

This is a development/testing environment. Test manually using:

- `curl` commands for API endpoints
- Browser for UI pages at `http://localhost:3000`
- Bitkit app for end-to-end testing (see README.md)

### Key Endpoints to Test

- `/decode` - BOLT11, LNURL, and BIP21 decoding
- `/generate` - LNURL generation
- `/health` - Health check
- `/.well-known/lnurlp/:username` - Lightning Address

---

## Important Files

| File | Purpose |
|------|---------|
| `lnurl-server/routes/decoder.js` | Decode API (BOLT11, LNURL, BIP21) |
| `lnurl-server/templates.js` | All HTML templates and UI |
| `lnurl-server/server.js` | Express app entry point |
| `docker-compose.yml` | Service orchestration |
| `CHANGELOG.md` | Change history (MUST maintain) |
