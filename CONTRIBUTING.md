# Contributing

## Dev setup
See the [README quick start](README.md#quick-start-local-dev). You need Node 20+,
Rust 1.80+, and MongoDB.

## Project conventions

**Rust (backend + daemon)**
- Format with `cargo fmt`; lint with `cargo clippy`.
- Errors return `AppError` (clean client message; full detail logged).
- Models live in `backend/src/models.rs`; routes in `backend/src/routes/`.
- `Id`/date fields serialize as hex/ISO strings in JSON and native BSON on the
  wire — keep new date fields annotated with `#[serde(with = "bson_dt")]`.

**Frontend**
- Build UI from the primitives in `src/components/ui/` and the design tokens in
  `tailwind.config.js` / `src/index.css`. Avoid ad-hoc `isDarkMode ? …` styling.
- Data fetching via TanStack Query; realtime via the `useSocketEvent` hook
  (never `socketService.off(event)` without a callback).
- Prefer typed props/responses over `any`.

## Tests & checks (run before a PR)

```bash
# Backend
cargo fmt --manifest-path backend/Cargo.toml --check
cargo clippy --manifest-path backend/Cargo.toml
cargo test  --manifest-path backend/Cargo.toml

# Daemon
cargo build --manifest-path daemon/Cargo.toml
cargo build --manifest-path daemon/Cargo.toml --features plc

# Frontend
npx tsc -p tsconfig.app.json --noEmit
npm run build
npm run lint
```

CI (`.github/workflows/ci.yml`) runs these on every push/PR.

## Commits & PRs
- Small, focused commits with imperative messages.
- Don't commit secrets or `.env` files (only `.env.example`).
- Note any change to the daemon→backend POST contract or the Socket.IO event
  shapes (frontend and backend must stay in sync).

## Reporting issues
Bugs and features via the issue tracker. **Security issues**: email the
maintainers privately (see [docs/SECURITY.md](docs/SECURITY.md)), don't open a
public issue.
