<div align="center">

# LineSentry

### Real-time OEE · MTTR · MTBF analytics for the factory floor

Ingest PLC signals at the edge, compute live machine metrics, classify stoppages,
and drive real-time dashboards — an open, vendor-neutral alternative to costly,
inflexible legacy systems.

![Rust](https://img.shields.io/badge/Backend-Rust%20·%20Axum-000000?logo=rust&logoColor=white)
![React](https://img.shields.io/badge/Frontend-React%2018%20·%20TS-61DAFB?logo=react&logoColor=black)
![MongoDB](https://img.shields.io/badge/Data-MongoDB-47A248?logo=mongodb&logoColor=white)
![Socket.IO](https://img.shields.io/badge/Realtime-Socket.IO-010101?logo=socketdotio&logoColor=white)
![Docker](https://img.shields.io/badge/Deploy-Docker%20Compose-2496ED?logo=docker&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue)

</div>

---

> Built for Dawlance to monitor injection-molding and assembly lines — generic
> enough for **any** machine that exposes digital signals through a PLC, and
> scalable from a single machine to **hundreds across many PLCs**.

## Highlights

| | |
|---|---|
| **Scales to many PLCs** | A PLC registry plus a per-PLC dynamic pin space (`Q0.0…Q{n}.7`). Map signals to machines across one device or hundreds. |
| **Guided setup** | A readiness checklist wires each machine's power + cycle signals in one step, and shows exactly what's left before metrics go live. |
| **Live OEE / MTTR / MTBF** | Availability × performance × quality, computed per machine, department, and factory over any timeframe. |
| **Real-time timeline** | Hour-by-hour production with operator/mold assignment and stoppage classification, streamed over Socket.IO. |
| **Rust core** | Axum backend + Tokio edge daemon — memory-safe, fast, and integration-tested. |
| **Secure by default** | JWT + bcrypt, mandatory CAPTCHA, rate limiting, API-key signal ingestion, RBAC. |

## Table of contents
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [How it works](#how-it-works)
- [Mapping signals to machines](#mapping-signals-to-machines)
- [Repository layout](#repository-layout)
- [Quick start](#quick-start-local-dev)
- [Deployment](#deployment-docker-compose)
- [Configuration](#configuration)
- [Security](#security)
- [Documentation](#documentation)

## Architecture

```
        Factory floor                              Server  (scales horizontally)
   ┌────────────────────────┐
   │  PLC 1 ┐                │    X-API-Key
   │  PLC 2 ┼── one daemon ──┼──── per PLC ────▶ ┌──────────────────┐     ┌────────────┐
   │  PLC N ┘   each (Rust)  │   POST /pin-data  │   Rust backend   │────▶│  MongoDB   │
   └────────────────────────┘   { plcId, hex }   │      (Axum)      │     └────────────┘
                                                  │  pipeline · OEE  │
   ┌────────────┐   REST + Socket.IO              │  · state machine │
   │  Browser   │◀──────── nginx ────────────────▶│                  │
   │  (React)   │                                 └──────────────────┘
   └────────────┘
```

Each daemon reads its PLC's output bytes and POSTs them (hex + `plcId` + timestamp).
The backend decodes the bytes into `Q{byte}.{bit}` pins, resolves each `(plcId, pin)`
to a sensor (`power` or `unit-cycle`) and machine, then runs a 4-state machine —
**running · stoppage · stopped_yet_producing · inactive** — persisting hourly
production records and broadcasting live updates.

## Tech stack

| Layer | Technology |
|-------|------------|
| **Frontend** | React 18 · TypeScript · Vite · TailwindCSS (token-based design system) · TanStack Query · Socket.IO client · Recharts |
| **Backend** | **Rust** — Axum · Tokio · `mongodb` · `socketioxide` · `jsonwebtoken` + `bcrypt` · `lettre` (email) · `printpdf` (reports) |
| **Database** | MongoDB |
| **Edge daemon** | **Rust** — Tokio + `reqwest`; Siemens S7 via `snap7-rs` (feature-gated) or a built-in simulator |
| **Realtime / scale** | Socket.IO; Redis adapter-ready for horizontal scaling |
| **Deploy** | Docker Compose (nginx · backend · MongoDB · Redis) |

> The Rust backend has fully replaced the original Node/Express server (now removed).
> The Python daemon (`python-daemon/`) is kept as a verified fallback until the Rust
> daemon's Siemens-S7 path is confirmed on real hardware. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## How it works

1. **Ingestion** — each daemon POSTs its PLC's bytes to `/api/signals/pin-data`,
   authenticated with a shared `X-API-Key`. Retries with exponential backoff;
   idempotent (per PLC) against duplicates.
2. **Pipeline** — the backend decodes the bytes, resolves each `(plcId, Q{byte}.{bit})`
   to a sensor (cached), updates `SignalData` + hourly `ProductionRecord`s, runs the
   state machine, and emits Socket.IO events — recomputing only the machines on the
   posting PLC, so cost stays flat as the plant grows.
3. **Analytics** — OEE = availability × quality × performance; MTBF/MTTR from
   breakdown stoppages; aggregated per machine / department / factory over any
   timeframe (bucketed in the factory's local timezone).
4. **Operations** — operators classify stoppages (with SAP notification IDs) and log
   defects; admins manage PLCs, departments, machines, signals, molds, shifts,
   thresholds, and email reporting.

## Mapping signals to machines

A **signal** is a sensor (role `power` or `unit-cycle`) bound to a PLC pin. The
**Setup** page makes a machine production-ready in three checks:

```
   Power signal wired   ->  availability + running time
   Cycle signal wired   ->  units produced + quality
   Mold defined         ->  ideal rate -> performance -> OEE
```

PLCs live in a **registry** (id · name · connection · byte count). Pins are addressed
Siemens-style `Q{byte}.{bit}`, and every mapping is scoped to its `plcId` — so a
4-byte PLC offers 32 pins (`Q0.0…Q3.7`), and `line-1 · Q0.0` is independent of
`line-2 · Q0.0`. Run **one daemon per PLC** (`PLC_ID` + `BYTE_COUNT`), or a single
entry with more bytes for a head/gateway PLC that aggregates others.

## Repository layout

```
/                 React frontend (Vite)
/backend          Rust backend (Axum + MongoDB + Socket.IO)        <- primary
/daemon           Rust edge daemon (simulator + S7 PLC reader)     <- primary
/python-daemon    Legacy Python daemon (fallback / S7 reference)
/deploy           docker-compose.yml, Dockerfiles, nginx config
/docs             ARCHITECTURE · SECURITY · DEPLOYMENT · openapi.yaml
/.github          CI workflows
```

## Quick start (local dev)

**Prerequisites:** Node 20+, Rust 1.80+, MongoDB (local or Atlas).

```bash
# 1 - Backend (Rust)
cd backend
cp .env.example .env          # set JWT_SECRET, DAEMON_API_KEY, MONGODB_URI
cargo run                     # -> http://localhost:3001

# 2 - Frontend (React), from the repo root
cp .env.example .env          # set VITE_API_BASE_URL + VITE_SOCKET_URL
npm install
npm run dev                   # -> http://localhost:5173

# 3 - Seed demo data + a simulated signal source
curl -X POST http://localhost:3001/api/auth/init-demo     # admin/admin123 · operator/operator123
cd daemon && BACKEND_URL=http://localhost:3001 DAEMON_API_KEY=<same> \
             PLC_ID=default BYTE_COUNT=2 SOURCE=simulator cargo run
```

Log in at **http://localhost:5173** with `admin` / `admin123`, then open **Setup**
to register a PLC and wire your first machine's signals.

## Deployment (Docker Compose)

```bash
cp deploy/.env.example deploy/.env        # set JWT_SECRET, DAEMON_API_KEY, etc.
docker compose -f deploy/docker-compose.yml up -d --build
```

Brings up nginx (frontend) + the Rust backend + MongoDB + Redis. Each daemon runs on
the Raspberry Pi next to its PLC (see [daemon/README.md](daemon/README.md)).
Full guide: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Configuration

Every service ships a documented `.env.example`. Key backend variables:
`MONGODB_URI`, `JWT_SECRET`, `DAEMON_API_KEY`, `RECAPTCHA_SECRET_KEY`, `CORS_ORIGIN`,
`REDIS_URL`, and `FACTORY_UTC_OFFSET_MINUTES` (bucket production in the factory's
local time). The backend refuses to start if required secrets are missing.

## Security

JWT auth (bcrypt-hashed passwords), mandatory reCAPTCHA on login, per-IP rate
limiting, an `X-API-Key` gate on signal ingestion, input validation, security
headers, and CORS locked to configured origins. Threat model and details:
[docs/SECURITY.md](docs/SECURITY.md).

## Documentation

| Doc | What's inside |
|-----|---------------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flow, the signal pipeline |
| [docs/SECURITY.md](docs/SECURITY.md) | Auth, RBAC, hardening, threat model |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Docker, scaling, ops runbook |
| [docs/openapi.yaml](docs/openapi.yaml) | REST API reference |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Dev setup, conventions, tests |

<div align="center"><sub>Built with 🦀 Rust and ⚛️ React · MIT licensed</sub></div>
