# ── Stage 1: Build ────────────────────────────────────────────────
FROM rust:1.82 AS builder
WORKDIR /app

# Install system deps needed by russh / ring / openssl crates
RUN apt-get update && apt-get install -y \
  pkg-config \
  libssl-dev \
  cmake \
  build-essential \
  && rm -rf /var/lib/apt/lists/*

COPY . .
RUN cargo build --release -p relay

# ── Stage 2: Run ──────────────────────────────────────────────────
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /data
COPY --from=builder /app/target/release/relay /usr/local/bin/relay

# 8080 = HTTP API   |   2222 = SSH relay tunnel
EXPOSE 8080 2222

ENV PUBLIC_URL=""
ENV API_BIND="0.0.0.0:8080"
ENV BIND="0.0.0.0:2222"

ENTRYPOINT sh -c 'relay \
  --api-bind "$API_BIND" \
  --bind "$BIND" \
  --host-key /data/host.key \
  ${PUBLIC_URL:+--public-url "$PUBLIC_URL"}'
