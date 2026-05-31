# Security

## Authentication & authorization
- **JWT** access tokens (HS256), configurable lifetime. Passwords hashed with
  **bcrypt** (cost 12). Token verified on every request via an Axum extractor
  that also loads the user and checks `isActive`.
- **RBAC**: `admin` vs `operator`. Admin-only endpoints require the `AdminUser`
  extractor; operators are scoped to their own department (machines, molds,
  users, department views). The frontend mirrors this with route guards
  (defense-in-depth; the backend is authoritative).
- **Login CAPTCHA**: Google reCAPTCHA v2 is verified server-side and is
  **mandatory whenever a secret is configured** (always in production). The
  hardcoded Google test secret was removed.

## Machine-to-machine ingestion
`POST /api/signals/pin-data` (and the other signal routes) require an
`X-API-Key` header compared in **constant time** to `DAEMON_API_KEY`. The daemon
sends it on every request. Ingestion is exempt from the general rate limiter (the
key is the control) but everything else is limited.

## Rate limiting
Per-IP fixed window (honors `X-Forwarded-For` behind nginx). Defaults: **5 login
attempts / 15 min** and **300 general requests / 15 min**; health checks and
`/api/signals` are exempt. Tunable via `RATE_LIMIT_*` env vars.

## Input handling
- Search parameters are escaped before reaching MongoDB `$regex` (no NoSQL/ReDoS
  injection); ObjectIds are validated before queries.
- Request bodies are typed/deserialized; `pinData` must be a 1-byte hex string.
- Errors are logged server-side but responses are **generic** ("Internal server
  error") — no stack traces, paths, or DB hints leak to clients.

## Transport & headers
Security headers + compression via `tower-http`; CORS locked to `CORS_ORIGIN`
(comma-separated allowlist). In production, terminate TLS at nginx/your ingress
and serve the app and API on one origin.

## Secrets & configuration
- The backend **fails fast** at startup if `JWT_SECRET`, `MONGODB_URI`, or
  `DAEMON_API_KEY` are missing (and `RECAPTCHA_SECRET_KEY` in production).
- Secrets come from env / `.env` (gitignored); `.env.example` templates document
  every variable. Generate strong values: `openssl rand -base64 48`.
- `/api/auth/init-demo` (which seeds known-credential demo accounts) is
  **disabled in production**.
- SMTP credentials for email reports are stored in the `config` document; rotate
  them and restrict the recipient list. (A follow-up will encrypt the SMTP
  password at rest.)

## Threat model notes
- **Edge network**: the PLC and daemon live on the factory LAN. The API key
  protects ingestion if the LAN is reachable; restrict network access to the PLC
  and backend regardless.
- **Replay/duplication**: ingestion is idempotent over `{timestamp, pinData}`.
- **Data integrity**: only authenticated admins can mutate configuration;
  operators can only classify stoppages / log defects for their department.

## Reporting a vulnerability
Email the maintainers (see `CONTRIBUTING.md`). Do not file public issues for
security reports.
