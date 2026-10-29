#!/usr/bin/env bash
# Deploys the dev branch of both repos to this server.
#
# GitHub Actions runs it over SSH after every merge into dev: the deploy key in
# ~deploy/.ssh/authorized_keys may run this script and nothing else. To deploy
# by hand, as the deploy user:
#   /opt/inc-logistics/deploy/hetzner/deploy.sh
#
#   1. Back up the database, replacing the previous pre-deploy backup (skip
#      with SKIP_BACKUP=1).
#   2. Move both checkouts to the tip of origin/dev, then carry on with the
#      copy of this script just pulled, so a change to it applies at once.
#   3. Build the api and web images. A failed build leaves the site as it was.
#   4. Start the new containers and wait for api, web and the site through
#      Caddy to answer.
#   5. If they don't, put the previous images and code back, and fail.
#   6. Otherwise trim Docker's build cache to BUILD_CACHE_MAX, so builds stay
#      fast without the cache filling the disk.
#
# One deploy runs at a time; a second one waits for the first to finish.
set -euo pipefail

BRANCH=dev
BACKEND=/opt/inc-logistics
FRONTEND=/opt/inc_frontend
HEALTH_TIMEOUT=180   # seconds
BUILD_CACHE_MAX=2gb

log() { echo "$(date -u +%FT%TZ)  $*"; }

# Move a checkout to the tip of origin/$BRANCH, whatever state it was in.
sync_repo() {
  git -C "$1" fetch -q origin "$BRANCH"
  git -C "$1" reset -q --hard FETCH_HEAD
}

# Point inc-logistics-{api,web}:<to> at the image tagged :<from>. The image
# store deletes an image as soon as its last tag moves, so the running images
# must be tagged :previous before a build moves :latest.
tag_images() {
  local svc
  for svc in api web; do
    docker tag "inc-logistics-$svc:$1" "inc-logistics-$svc:$2"
  done
}

restore_code() {
  git -C "$BACKEND" reset -q --hard "$DEPLOY_PREV_BACKEND"
  git -C "$FRONTEND" reset -q --hard "$DEPLOY_PREV_FRONTEND"
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
  cd "$BACKEND/deploy/hetzner"

  # First pass, in whichever copy of this script was on disk: lock, back up,
  # update both checkouts, then start again in the copy just pulled.
  if [ -z "${DEPLOY_PREV_BACKEND:-}" ]; then
    exec 9>/tmp/inc-logistics-deploy.lock
    flock -w 1800 9 || { log "another deploy is still running; giving up"; exit 1; }
    if [ "${SKIP_BACKUP:-0}" != 1 ]; then
      log "backing up the database"
      BACKUP_NAME=pre-deploy ./backup.sh
    fi
    DEPLOY_PREV_BACKEND="$(git -C "$BACKEND" rev-parse HEAD)"
    DEPLOY_PREV_FRONTEND="$(git -C "$FRONTEND" rev-parse HEAD)"
    DEPLOY_PREV_CADDY="$(sha256sum Caddyfile)"
    export DEPLOY_PREV_BACKEND DEPLOY_PREV_FRONTEND DEPLOY_PREV_CADDY
    sync_repo "$BACKEND"
    sync_repo "$FRONTEND"
    exec bash "$BACKEND/deploy/hetzner/deploy.sh"   # the lock on fd 9 carries over
  fi

  # Caddy reads its file through a bind mount, which only follows a replaced
  # file after a restart.
  local caddy_changed=0
  [ "$DEPLOY_PREV_CADDY" = "$(sha256sum Caddyfile)" ] || caddy_changed=1
  log "backend:  $(git -C "$BACKEND" log -1 --format='%h %s')"
  log "frontend: $(git -C "$FRONTEND" log -1 --format='%h %s')"

  tag_images latest previous
  log "building"
  if ! docker compose build api web; then
    log "build failed; the site is still running the previous version"
    tag_images previous latest
    restore_code
    exit 1
  fi

  log "starting the new version"
  docker compose up -d --no-build
  [ "$caddy_changed" = 0 ] || docker compose restart caddy

  if healthy; then
    docker image prune -f >/dev/null
    docker builder prune -f --max-used-space "$BUILD_CACHE_MAX" >/dev/null
    log "deploy finished"
    return
  fi

  log "the new version did not come up healthy; rolling back"
  docker compose logs --no-color --tail 40 api web || true
  tag_images previous latest
  restore_code
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
