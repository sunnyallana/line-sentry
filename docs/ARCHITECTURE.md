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

## Data access: persisters (`backend/src/persist/`)

Nothing outside `persist/` builds a database query. Routes, the pipeline and
the background jobs ask an entity's persister for what they need in domain
terms (`store.machines.live_states(..)`, `store.records.open_stoppage(..)`).
Conditions that vary are built with two typed builders: `Filter` (which rows)
and `Changes` (what to change, always as atomic server-side operators). Field
names live as constants beside each persister, so a schema change is made in
one file and a slow query has one owner. Tests follow the same rule.

| Piece | What it is for |
|-------|----------------|
| `Persister<T>` | The operations every entity gets: find, page, select (named fields only), insert, insert many, update one / all, upsert, update-and-return, delete. |
| Entity persisters | One file per entity with its named operations and any aggregation it needs. |
| `Batch` | Several single-row writes, to any collections, sent together. One `bulkWrite` command on MongoDB 8+; concurrent writes on the pool on older servers. The server is asked once at start. |
| `BulkEntityWriter` | Takes writes off the request path. Callers hand over a keyed value without waiting; one background task stores what arrived in bulk on a one-second timer or when a batch fills. A later value for a key replaces an earlier unstored one. `flush()` before a read that needs fresh rows; a clean shutdown stores what is buffered. |
| `schema` | Indexes and one-off data migrations, run at start. |

The bulk writer carries the two writes where only the latest value matters and
a second of delay is invisible: each sensor's current reading and each
machine's last-power mark. Unit counts never go through it: a daemon must not
be told a reading was applied before its units are stored.

## The signal pipeline (`backend/src/pipeline.rs`)

PLCs live in a registry; each exposes `8 × byteCount` output pins. A daemon posts
its PLC's bytes under a `plcId`, and bit *i* of byte *b* = pin `Q{b}.{i}` (Siemens
byte.bit). Each `(plcId, pin)` is mapped to a `Sensor` of type `power` or
`unit-cycle`, which belongs to a `Machine`.

Everything that decides an outcome is in the database, not in the process: a
machine's last power pulse, last cycle pulse and last counted running minute
are fields on its row; every write to a production record is one atomic update
guarded by its own condition; a retried payload is recognised by a short-lived
receipt. So a restart loses nothing, any number of backend instances can take
payloads for the same PLC, and two payloads landing together cannot overwrite
each other's counts.

For each payload:
1. **Validate and deduplicate.** Reject non-hex. A payload with a timestamp is
   applied once, whichever instance each attempt reaches.
2. **Read** the live state of the PLC's machines (one read).
3. **First batch**: last-cycle marks, running-minute claims (exactly one payload
   per minute wins the claim), and status changes. Readings and power marks go
   to the bulk writer instead.
4. **Second batch**: unit counts (with the gap since the previous unit, for the
   hour's cycle-time histogram) and running minutes.
5. **Transitions**, which are rare and written one by one: a stoppage opening
   (power, no cycle) or closing (cycles resume).
6. **Emit** realtime events from one read of the hour buckets that changed.

| has power | has cycle | state | shown as |
|-----------|-----------|-------|----------|
| ✓ | ✓ | `running` | Running |
| ✓ | ✗ | `stoppage` | Stopped |
| ✗ | ✓ | `stopped_yet_producing` | Producing, no power signal |
| ✗ | ✗ | `inactive` | Idle |

`POST /api/signals/pin-data/batch` takes up to 600 timestamped readings in
order. The edge daemon keeps an outbox and uses it to replay an outage with the
original timestamps, so production lands in the right minute and hour.

### Measured

`node scripts/bench-ingest.mjs` against release builds on one developer
machine, 8 machines, every payload carrying a unit for each machine:

| | per payload (p50) | 8 concurrent | units lost under concurrency |
|---|---|---|---|
| Before (read-modify-write, state in memory) | 23.0 ms | 259 payloads/s | 2,477 of 4,800 |
| Now, MongoDB 7 | 5.1 ms | 799 payloads/s | 0 |
| Now, MongoDB 8 (`bulkWrite`) | 4.7 ms | 1,186 payloads/s | 0 |

### Socket.IO events
`machine-state-update` (on change only), `production-update`,
`running-time-update`, `unclassified-stoppage-detected`, `stoppage-resolved`,
`stoppage-updated`, `stoppage-added`, `production-assignment-updated`, `alert`.
Typed in `src/services/socket.ts`; subscribe via the `useSocketEvent` hook.

## Background work: pulse and leases (`backend/src/pulse.rs`, `lease.rs`)

Periodic work runs on the **pulse**: one task per job, each on its own jittered
timer, so a slow or failing job never delays another and instances started
together do not hit the database in the same instant. A job that keeps failing
logs its first failure and then every tenth.

| Job | Every | Leased | What it does |
|-----|-------|--------|--------------|
| `stoppage-tick` | 60 s | yes | Updates the duration of every stoppage still open on a machine that is still stopped. |
| `silent-plc-sweep` | 30 s | yes | Sets machines to `inactive` when every PLC they are wired to has stopped posting for longer than both signal timeouts. |
| `stoppage-alerts` | 60 s | yes | Raises an alert when a machine stays stopped past the configured minutes, and a second one to the escalation list if it stays stopped longer. Each is sent once, by email and webhook. |
| `daily-report` | 5 min | yes | Once the factory clock passes the configured hour, stores yesterday's report and emails it. |

A job that changes shared data takes a **lease** first: one row per job in the
`leases` collection. Only an expired lease can be taken, the holder renews it at
a quarter of its length while it works, and the run's result is written to the
row when it is freed. If the holder dies the lease expires and another instance
takes over. Three details make this safe with several backend instances:

- Expiry uses the database clock (`$$NOW`), not each instance's own clock.
- Every take writes a new token and every later write is conditional on it, so
  an instance that lost the lease can no longer change the row.
- When a renew shows the lease is gone, the running work is cancelled.

The row also holds a `cursor` that only moves forward. The daily report stores
the last day it finished there, which is what makes it run once per day across
restarts and instances. A failed email leaves the cursor alone, so the next
round retries with the report that is already stored.

Each daemon post stamps `plcs.lastSeenAt` (at most every 10 s per PLC). The
sweep reads that stamp, so a machine whose daemon died no longer shows its last
state forever.

`GET /api/pulse` (admin) returns this instance's job status and every lease
row. `PULSE_ENABLED=false` switches all background jobs off.

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

## Floor and loss views (`backend/src/routes/insights.rs`)

Two read-only endpoints load the production records once and fold them in
memory, so a page makes one request instead of one per machine:

- `GET /api/analytics/floor`: every visible machine's state, when it entered
  that state (`statusSince`, written only when the state really changes),
  today's units, the current hour against what the mold should have made by
  now, and any stoppage still waiting for a reason. The Overview and the
  wall-screen board (`/board`) read this.
- `GET /api/analytics/losses?startDate&endDate&departmentId&machineId`: totals
  (OEE and its three factors, MTBF, MTTR, breakdowns per 100 running hours),
  stoppage time by reason with a running share, and the same figures cut by
  machine, shift, operator, mold and day. The Analysis page reads this and
  exports any cut as CSV.

Operators only ever get their own department from either endpoint. Performance
is capped at 100%: output above the mold's ideal rate means the rate or the
recorded running time is wrong, and an OEE above 100% would only mislead.

## Data model (MongoDB collections)

`users`, `departments`, `machines`, `molds`, `sensors`, `sensorpinmappings`,
`plcs`, `signaldatas`, `productionrecords` (with embedded `hourlyData[]` →
`stoppages[]`), `configs`, `reports`, `leases`. ObjectIds serialize as hex strings and dates
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
