#!/usr/bin/env bash
set -euo pipefail

# Install this script outside the releases, under root ownership.
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
sha="${SSH_ORIGINAL_COMMAND:-}"
if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Expected a Git commit SHA" >&2
  exit 2
fi
if [[ ! -s "$root/site.env" ]]; then
  echo "Missing server settings at $root/site.env" >&2
  exit 2
fi

cd "$root/releases"
exec 9>.deploy.lock
flock -w 90 9

previous=$(readlink current || true)
release=$(mktemp -d "release-$sha.XXXXXXXX")
switch_link() {
  ln -s -- "$1" "$release/.current"
  mv -Tf -- "$release/.current" current
}
service=(sudo -n /usr/bin/systemctl)
unit=antipov-team.service
check_site() {
  for _ in {1..15}; do
    if curl --fail --silent --max-time 2 http://127.0.0.1:3000/api/news >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

cleanup() {
  if [[ "$(readlink current || true)" != "$release" ]]; then
    rm -rf -- "$release"
    return
  fi
  echo "Deployment failed. Restoring the previous release." >&2
  if [[ -n "$previous" ]]; then
    if ! switch_link "$previous" || ! "${service[@]}" restart "$unit" || ! check_site; then
      echo "Rollback failed. Check the service on the VPS." >&2
      return
    fi
  else
    "${service[@]}" stop "$unit" || return
    rm -- current
  fi
  rm -rf -- "$release"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

tar -xzf - --no-same-owner --no-same-permissions -C "$release"
[[ -f "$release/server.js" && -f "$release/public/index.html" && -d "$release/node_modules/express" ]]
ln -s -- "$root/site.env" "$release/.env"
chmod 0755 -- "$release"

switch_link "$release"
"${service[@]}" restart "$unit"
check_site
trap - EXIT

for directory in release-*/; do
  directory=${directory%/}
  if [[ "$directory" != "$release" && "$directory" != "$previous" ]]; then
    rm -rf -- "$directory"
  fi
done
echo "Deployed $sha"
