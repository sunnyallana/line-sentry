# Architecture

## Components

| Component | Path | Responsibility |
|-----------|------|----------------|
| Frontend | `/` (`src/`) | React SPA: dashboards, department/machine views, production timeline, admin CRUD, reports. Served by nginx in production. |
| Backend | `/backend` | Rust (Axum) API + Socket.IO: auth, the signal pipeline, CRUD, analytics, reports. |
| Edge daemon | `/daemon` | Rust: reads the PLC digital byte (or simulates it) and posts to the backend. Runs on a Raspberry Pi beside the PLC. |
| Database | MongoDB | Users, departments, machines, sensors, pin mappings, signals, production records, config, reports. |
| Legacy | `/server`, `/python-daemon` | Original Node + Python implementations, kept as verified fallbacks. |

## Data flow

```
PLCs ──bytes──▶ daemons (one per PLC) ──POST /api/signals/pin-data (X-API-Key)──▶ backend pipeline
                                                                      │
        ┌─────────────────────────────────────────────────────────────┤
        ▼                                   ▼                          ▼
   SignalData (per sensor)        ProductionRecord (hourly)     Socket.IO broadcast
                                                                      │
                                                                      ▼
                                                          browser dashboards (live)
```

## The signal pipeline (`backend/src/pipeline.rs`)

PLCs live in a registry; each exposes `8 × byteCount` output pins. A daemon posts
its PLC's bytes under a `plcId`, and bit *i* of byte *b* = pin `Q{b}.{i}` (Siemens
byte.bit). Each `(plcId, pin)` is mapped (via `SensorPinMapping`, scoped by
`plcId`) to a `Sensor` of type `power` or `unit-cycle`, which belongs to a
`Machine` — so the platform scales from one machine to hundreds across many PLCs.

For each ingested PLC payload:
1. **Validate + dedup** — reject non-hex; drop exact `{timestamp, pinData}`
   retries so unit cycles aren't double-counted.
2. **Per pin** — upsert the latest `SignalData`; on a `power` pulse record
   last-power and emit `power-signal`; on a `unit-cycle` pulse increment the
   hour's `unitsProduced`, emit `production-update`, and resolve any pending
   stoppage.
3. **State machine** — using configurable power/cycle timeouts:

   | has power | has cycle | state | color |
   |-----------|-----------|-------|-------|
   | ✓ | ✓ | `running` | green |
   | ✓ | ✗ | `stoppage` (creates an unclassified stoppage) | red |
   | ✗ | ✓ | `stopped_yet_producing` | orange |
   | ✗ | ✗ | `inactive` | gray |

4. **Emit** — `machine-state-update`, `running-time-update`, and stoppage events.

Pin mappings are cached in memory (TTL), keyed by `(plcId, pin)`, instead of
re-aggregated per request; the cache is invalidated when signals are wired/removed.
Each payload recomputes state only for machines on the posting PLC, so ingestion
cost stays flat as the plant grows. A single background task ticks ongoing
unclassified-stoppage durations every 60s.

### Socket.IO events
`power-signal`, `machine-state-update`, `production-update`, `running-time-update`,
`unclassified-stoppage-detected`, `stoppage-resolved`, `stoppage-updated`,
`stoppage-added`, `production-assignment-updated`. Typed in
`src/services/socket.ts`; subscribe via the leak-free `useSocketEvent` hook.

## Analytics (`backend/src/routes/analytics.rs`)

Computed in Rust from production records (bucketed in the factory's local time
via `FACTORY_UTC_OFFSET_MINUTES`, defaulting to the host offset):

- **Availability** = runningMinutes / (runningMinutes + stoppageMinutes)
- **Quality** = (units − defects) / units
- **Performance** = units / expectedUnits, where expectedUnits = Σ (mold capacity/hr ÷ 60 × runningMinutes)
- **OEE** = availability × quality × performance
- **MTBF** = runningMinutes / breakdownCount · **MTTR** = breakdownMinutes / breakdownCount

Surfaced per machine, department (avg OEE), and factory (totals + active machines
+ unclassified count), over `today` / `week` / `month` / custom ranges.

## Data model (MongoDB collections)

`users`, `departments`, `machines`, `molds`, `sensors`, `sensorpinmappings`,
`plcs`, `signaldatas`, `productionrecords` (with embedded `hourlyData[]` →
`stoppages[]`), `configs`, `reports`. ObjectIds serialize as hex strings and dates
as ISO-8601 in JSON, but as native BSON types on the wire (see `backend/src/models.rs`).

Indexes created at startup: unique `users.username`/`email`, unique
`sensorpinmappings (plcId, pinId)` and `plcs.plcId`; time-series indexes on `signaldatas` and
`productionrecords{machineId, startTime}`; lookup indexes on `machines.departmentId`
and `sensors.machineId`.

## Realtime & scaling

The backend is stateless apart from in-memory pipeline caches; Socket.IO is
served via `socketioxide` and is **Redis-adapter-ready** (`REDIS_URL`) so
multiple backend instances can share rooms behind a load balancer. nginx
reverse-proxies `/api` and `/socket.io` (WebSocket upgrade) to the backend.

## Migration status

The Rust backend + daemon are the primary implementations, verified by an
integration suite (auth, RBAC, and the signal pipeline) plus live end-to-end
runs. The Node `server/` has been **removed** — the Rust backend fully replaces
it. The Python `python-daemon/` is **retained as a fallback** until the Rust
daemon's Siemens-S7 read is confirmed against real PLC hardware; the simulator
source is verified in CI, but the S7 FFI path cannot be exercised without a PLC.
