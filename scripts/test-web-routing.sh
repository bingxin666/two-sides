#!/usr/bin/env bash
set -euo pipefail

# Exercises the same Caddyfile and dist directory used by apps/web/Dockerfile.
# The backend is a disposable Caddy responder; no application credentials or
# production services are involved.
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
network="two-sides-routing-${RANDOM}-${RANDOM}"
backend="${network}-backend"
frontend="${network}-frontend"
backend_dir="$(mktemp -d)"
frontend_port=""

cleanup() {
  docker rm -f "$frontend" "$backend" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$backend_dir"
}
trap cleanup EXIT

if [[ ! -d "$root_dir/apps/web/dist" ]]; then
  echo "apps/web/dist is missing; run pnpm build first" >&2
  exit 1
fi

cat >"$backend_dir/Caddyfile" <<'EOF'
:3000 {
  respond "{http.request.uri}" 200
}
EOF

docker network create "$network" >/dev/null
docker run -d --name "$backend" --network "$network" --network-alias server \
  -v "$backend_dir/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2-alpine >/dev/null

docker run -d --name "$frontend" --network "$network" -p 127.0.0.1::8080 \
  -v "$root_dir/apps/web/dist:/srv:ro" \
  -v "$root_dir/apps/web/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2-alpine >/dev/null

frontend_port="$(docker port "$frontend" 8080/tcp | sed -E 's/.*:([0-9]+)$/\1/')"
if [[ -z "$frontend_port" ]]; then
  echo "unable to determine Caddy port" >&2
  exit 1
fi

base_url="http://127.0.0.1:${frontend_port}"
request() {
  local url="$1"
  local body=""
  for _ in {1..30}; do
    if body="$(curl -fsS "$url" 2>/dev/null)"; then
      printf '%s' "$body"
      return 0
    fi
    sleep 1
  done
  echo "request did not become ready: $url" >&2
  return 1
}

request "$base_url/" >/dev/null

callback_body="$(request "$base_url/callback?authorization_code=test-only&state=test-only")"
[[ "$callback_body" == "/callback?authorization_code=test-only&state=test-only" ]] || {
  echo "callback was not proxied with its query intact: $callback_body" >&2
  exit 1
}

api_body="$(request "$base_url/api/v1/ping?probe=test-only")"
[[ "$api_body" == "/api/v1/ping?probe=test-only" ]] || {
  echo "api was not proxied with its query intact: $api_body" >&2
  exit 1
}

spa_body="$(request "$base_url/q/routing-regression")"
grep -q '<div id="app"' <<<"$spa_body" || {
  echo "SPA fallback did not serve index.html" >&2
  exit 1
}

echo "web Caddy routing regression passed"
