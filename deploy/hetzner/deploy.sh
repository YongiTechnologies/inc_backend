#!/usr/bin/env bash
# Deploys the dev branch of both repos to this server.
#
# GitHub Actions runs it over SSH after every merge into dev: the deploy key in
# ~deploy/.ssh/authorized_keys may run this script and nothing else. To deploy
# by hand, as the deploy user:
#   /opt/inc-logistics/deploy/hetzner/deploy.sh
#
#   1. Back up the database (skip with SKIP_BACKUP=1).
#   2. Move both checkouts to the tip of origin/dev.
#   3. Build the api and web images. A failed build leaves the site as it was.
#   4. Start the new containers and wait for api, web and the site through
#      Caddy to answer.
#   5. If they don't, put the previous images and code back, and fail.
#
# One deploy runs at a time; a second one waits for the first to finish.
set -euo pipefail

BRANCH=dev
BACKEND=/opt/inc-logistics
FRONTEND=/opt/inc_frontend
HEALTH_TIMEOUT=180   # seconds

log() { echo "$(date -u +%FT%TZ)  $*"; }

# Move a checkout to the tip of origin/$BRANCH, whatever state it was in.
sync_repo() {
  git -C "$1" fetch -q origin "$BRANCH"
  git -C "$1" reset -q --hard FETCH_HEAD
}

# Tag the image each container is running as :previous, so a bad release can
# be undone without a rebuild.
keep_running_images() {
  local svc id
  for svc in api web; do
    id="$(docker compose ps -aq "$svc")"
    if [ -n "$id" ]; then
      docker tag "$(docker inspect --format '{{.Image}}' "$id")" "inc-logistics-$svc:previous"
    fi
  done
}

restore_previous_images() {
  local svc
  for svc in api web; do
    if docker image inspect "inc-logistics-$svc:previous" >/dev/null 2>&1; then
      docker tag "inc-logistics-$svc:previous" "inc-logistics-$svc:latest"
    fi
  done
}

# True once api and web answer inside their containers and the site answers
# through Caddy, the way visitors reach it.
healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) domain
  domain="$(grep -E '^WEB_DOMAIN=' .env | cut -d= -f2- || true)"
  until docker compose exec -T api wget -qO /dev/null http://localhost:5000/health 2>/dev/null &&
        docker compose exec -T web wget -qO /dev/null http://127.0.0.1:3000/ 2>/dev/null &&
        { [ -z "$domain" ] || curl -fsS -o /dev/null --max-time 10 \
            --resolve "$domain:443:127.0.0.1" "https://$domain/api/health"; }; do
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 3
  done
}

main() {
  exec 9>/tmp/inc-logistics-deploy.lock
  flock -w 1800 9 || { log "another deploy is still running; giving up"; exit 1; }

  cd "$BACKEND/deploy/hetzner"

  if [ "${SKIP_BACKUP:-0}" != 1 ]; then
    log "backing up the database"
    ./backup.sh
  fi

  local old_back old_front old_caddy caddy_changed=0
  old_back="$(git -C "$BACKEND" rev-parse HEAD)"
  old_front="$(git -C "$FRONTEND" rev-parse HEAD)"
  old_caddy="$(sha256sum Caddyfile)"

  sync_repo "$BACKEND"
  sync_repo "$FRONTEND"
  log "backend:  $(git -C "$BACKEND" log -1 --format='%h %s')"
  log "frontend: $(git -C "$FRONTEND" log -1 --format='%h %s')"
  # Caddy reads its file through a bind mount, which only follows a replaced
  # file after a restart.
  [ "$old_caddy" = "$(sha256sum Caddyfile)" ] || caddy_changed=1

  log "building"
  if ! docker compose build api web; then
    log "build failed; the site is still running the previous version"
    git -C "$BACKEND" reset -q --hard "$old_back"
    git -C "$FRONTEND" reset -q --hard "$old_front"
    exit 1
  fi

  keep_running_images
  log "starting the new version"
  docker compose up -d --no-build
  [ "$caddy_changed" = 0 ] || docker compose restart caddy

  if healthy; then
    docker image prune -f >/dev/null
    log "deploy finished"
    return
  fi

  log "the new version did not come up healthy; rolling back"
  docker compose logs --no-color --tail 40 api web || true
  restore_previous_images
  git -C "$BACKEND" reset -q --hard "$old_back"
  git -C "$FRONTEND" reset -q --hard "$old_front"
  docker compose up -d --no-build
  [ "$caddy_changed" = 0 ] || docker compose restart caddy
  if healthy; then
    log "rolled back to the previous version"
  else
    log "ROLLBACK IS NOT HEALTHY EITHER: check the server now"
  fi
  exit 1
}

# On one line so bash has read it all before the checkout above rewrites this file.
main "$@"; exit
