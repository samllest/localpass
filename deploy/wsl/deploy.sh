#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bundle="${1:?Usage: deploy.sh /path/to/prepared/site [destination]}"
deploy_dir="${2:-$HOME/apps/localpass}"
test -f "$bundle/index.html"
test -f "$bundle/SHA256SUMS.txt"
(cd "$bundle" && sha256sum -c SHA256SUMS.txt)
docker info >/dev/null
release="$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$deploy_dir/releases/$release"
cp -a "$bundle/." "$deploy_dir/releases/$release/"
cp "$script_dir/compose.yaml" "$script_dir/nginx.conf" "$deploy_dir/"
ln -sfn "releases/$release" "$deploy_dir/site"
docker compose -f "$deploy_dir/compose.yaml" up -d --force-recreate
binding="$(docker compose -f "$deploy_dir/compose.yaml" port downloads 80)"
binding="${binding%%$'\n'*}"
health_port="${binding##*:}"
curl --noproxy '*' --fail --retry 10 --retry-delay 1 --retry-connrefused "http://127.0.0.1:$health_port/health"
echo "LocalPass distribution backend is running at http://localhost:$health_port/"
echo "Deployment directory: $deploy_dir"
