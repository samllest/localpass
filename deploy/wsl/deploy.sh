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
curl --fail --retry 10 --retry-delay 1 --retry-connrefused "http://127.0.0.1:${LOCALPASS_DOWNLOAD_PORT:-18770}/health"
echo "LocalPass distribution is running at http://localhost:${LOCALPASS_DOWNLOAD_PORT:-18770}/"
echo "Deployment directory: $deploy_dir"
