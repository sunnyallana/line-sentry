# syntax=docker/dockerfile:1
# Simulator build (default). For real PLC reads, build natively on the target
# (e.g. the Raspberry Pi) with `--features plc` — that path needs libsnap7 and
# is not included in this image.

FROM rust:1-bookworm AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release && rm -rf src
COPY src ./src
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/target/release/linesentry-daemon /usr/local/bin/linesentry-daemon
COPY config.json ./config.json
RUN useradd -r -u 10001 iot
USER iot
CMD ["linesentry-daemon"]
