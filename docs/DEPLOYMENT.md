# Deployment

## On-prem with Docker Compose (recommended)

The factory floor runs a single host with the full stack; the daemon runs on the
Raspberry Pi next to the PLC.

```bash
cp deploy/.env.example deploy/.env      # set JWT_SECRET, DAEMON_API_KEY, RECAPTCHA_SECRET_KEY, CORS_ORIGIN
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps      # all healthy?
```

Services: `web` (nginx serving the built SPA + reverse-proxying `/api` and
`/socket.io`), `backend` (Rust API), `mongo` (with a named volume), `redis`.
The frontend is published on `${WEB_PORT:-80}`.

### Generate secrets
```bash
openssl rand -base64 48     # JWT_SECRET
openssl rand -base64 48     # DAEMON_API_KEY  (also set on the daemon)
```

## The edge daemon (Raspberry Pi)
Build with the PLC feature and run under systemd — see
[daemon/README.md](../daemon/README.md). Set the daemon's `DAEMON_API_KEY` to the
same value as the backend and point `BACKEND_URL` at the server.

## TLS
Terminate TLS at nginx (or a reverse proxy / ingress in front of `web`). Put the
app and API on **one origin** so the SPA uses `/api` and same-origin Socket.IO
(the frontend is already built for this). Set `CORS_ORIGIN` to that public origin.

## Scaling horizontally
The backend is stateless except for in-memory pipeline caches. To run multiple
instances behind a load balancer:
1. Set `REDIS_URL` so Socket.IO shares rooms across instances.
2. Use sticky sessions or WebSocket-aware LB routing for `/socket.io`.
3. Point all instances at the same MongoDB (use a replica set for HA).

This maps cleanly onto Kubernetes later (Deployment + Service + the same env);
Compose is the on-prem default.

## Backups
- **MongoDB**: schedule `mongodump` against the `mongo` volume (or use Atlas
  backups if hosted). Production records and config are the critical data.
- Keep `deploy/.env` in your secret manager, not in the repo.

## Ops runbook
- **Health**: `GET /api/health` → `200 {db:"connected"}` when healthy, `503`
  when the DB is unreachable; `GET /api/ready` for readiness. Compose healthchecks
  use these.
- **Logs**: `docker compose logs -f backend` (structured `tracing` output;
  tune with `RUST_LOG`). Daemon: `journalctl -u linesentry-daemon -f`.
- **Restart**: `docker compose restart backend`. The backend connects to Mongo
  lazily and reports `503` until it's reachable, so ordering is forgiving.
- **Seeding**: in non-production, `POST /api/auth/init-demo` creates demo
  accounts; in production create the first admin directly (script/console).
- **Daemon down**: signals during downtime are lost (no on-device buffer);
  restart restores live data. The PLC keeps producing regardless.
