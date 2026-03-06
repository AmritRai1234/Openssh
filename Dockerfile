# ── Stage 1: Build ────────────────────────────────────────────────
FROM rust:1.76-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
COPY . .
RUN cargo build --release -p relay

# ── Stage 2: Run ──────────────────────────────────────────────────
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /data
COPY --from=builder /app/target/release/relay /usr/local/bin/relay

# Ports: 8080 = HTTP API, 2222 = SSH relay
EXPOSE 8080 2222

# PUBLIC_URL must be set to your domain, e.g. https://relay.yourdomain.com
ENV PUBLIC_URL=""
ENV API_BIND="0.0.0.0:8080"
ENV BIND="0.0.0.0:2222"

ENTRYPOINT relay \
  --api-bind "$API_BIND" \
  --bind "$BIND" \
  --host-key /data/host.key \
  ${PUBLIC_URL:+--public-url "$PUBLIC_URL"}
