# LineSentry Edge Daemon (Rust)

A single-binary, 24/7 edge daemon that reads a PLC digital byte and posts it to
the backend's `POST /api/signals/pin-data` endpoint (with the `X-API-Key`
header). It is the Rust port of `python-daemon/` referenced in the project
README, built for reliable long-running operation on a Raspberry Pi: no GC
pauses, low memory, robust retry, and graceful shutdown.

## Two signal sources

| Source | Feature | Use |
|--------|---------|-----|
| **Simulator** (default) | built-in | Dev/test/demo with no hardware. Pins 4–7 act as "power" (held on); pins 0–3 as unit-cycle sensors that pulse — so whatever the backend has mapped reacts. |
| **PLC** (Siemens S7) | `--features plc` | Reads `Area.PA` byte 0 via libsnap7 — the exact byte the Python `signal_recorder.py` reads. |

The POST contract is identical to the Python daemon:
`{"pinData": "0f", "timestamp": "<RFC3339>"}` → `{message, processedMachines}`.
Bit *i* of the hex byte maps to pin `DQ.i`.

## Build & run

```bash
# Simulator (any machine):
cargo run --release

# Real PLC (on the Pi / a host with libsnap7 installed):
#   Debian/RPi:  sudo apt-get install libsnap7-1 libsnap7-dev
cargo build --release --features plc
SOURCE=plc PLC_IP=192.168.0.1 ./target/release/linesentry-daemon
```

Configuration comes from `config.json` (compatible with the Python daemon),
overridden by environment variables (see `.env.example`): `BACKEND_URL`,
`DAEMON_API_KEY` (**must** match the backend), `SOURCE`, `INTERVAL_SECONDS`,
`PLC_IP`/`PLC_RACK`/`PLC_SLOT`, `RUST_LOG`.

## Deploy (systemd, e.g. on the Raspberry Pi)

```bash
sudo mkdir -p /opt/linesentry-daemon
sudo cp target/release/linesentry-daemon config.json /opt/linesentry-daemon/
sudo cp .env.example /opt/linesentry-daemon/.env   # then edit secrets
sudo useradd -r iot
sudo cp linesentry-daemon.service /etc/systemd/system/
sudo systemctl enable --now linesentry-daemon
journalctl -u linesentry-daemon -f
```

### ARM cross-compile (build on x86, run on Pi)

```bash
rustup target add aarch64-unknown-linux-gnu        # 64-bit Pi OS
cargo build --release --target aarch64-unknown-linux-gnu --features plc
# (use a cross linker / `cross` for the plc feature so libsnap7 links for ARM)
```

## ⚠️ On-hardware verification required before PLC cutover

The simulator path is fully tested. The **PLC (S7) path cannot be tested without
a real Siemens PLC**, so before relying on it in production:

1. Run the proven Python `signal_recorder.py` and this Rust daemon (with
   `--features plc`) against the same PLC and confirm they read **identical
   bytes** (compare the logged hex).
2. Keep `python-daemon/` as the fallback until parity is confirmed.

The S7 area/word-length constants and the `snap7-rs` API calls in
`src/source.rs` (`plc` module) mirror the Python daemon; verify them against
your `snap7-rs` version on the target.
