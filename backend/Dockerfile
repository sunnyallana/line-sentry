# syntax=docker/dockerfile:1

# ── Builder ──────────────────────────────────────────────────────────────────
FROM rust:1-bookworm AS builder
WORKDIR /app

# Pre-build dependencies for layer caching (only re-runs when manifests change).
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs \
    && cargo build --release \
    && rm -rf src

# Build the real binary.
COPY src ./src
RUN touch src/main.rs && cargo build --release

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/target/release/linesentry-backend /usr/local/bin/linesentry-backend

ENV BIND_ADDR=0.0.0.0:3001 \
    RUST_LOG=info,linesentry_backend=info
EXPOSE 3001

# Run as a non-root user.
RUN useradd -r -u 10001 appuser
USER appuser

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:3001/api/health || exit 1

CMD ["linesentry-backend"]
