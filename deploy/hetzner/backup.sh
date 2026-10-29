#!/usr/bin/env bash
# Database backup: run nightly by cron on the Hetzner host, and by deploy.sh
# before each deploy.
#
# Dumps the whole database straight out of the running mongo container to a
# single gzipped archive (mongodump, which ships inside the mongo image).
#
# Nightly archives are copied offsite to Cloudflare R2 through the rclone
# remote "offsite", which encrypts them (keys and restore steps are in
# CONNECTION.md, which stays off git). R2 keeps them 90 days. This server keeps
# only the newest 3, or 14 while offsite isn't set up or an upload fails.
#
# deploy.sh runs it with BACKUP_NAME=pre-deploy: that archive replaces the
# previous one each time and stays on this server.
#
# Restore one with:
#   gunzip -c inc_logistics-STAMP.archive.gz | \
#     docker compose exec -T mongo sh -c \
#       'mongorestore --username "$MONGO_INITDB_ROOT_USERNAME" \
#          --password "$MONGO_INITDB_ROOT_PASSWORD" \
#          --authenticationDatabase admin --archive --gzip --drop'
#
# Install (as the deploy user):
#   crontab -e
#   17 2 * * *  cd /opt/inc-logistics/deploy/hetzner && ./backup.sh >> /opt/inc-logistics/backups/backup.log 2>&1
# (02:17 UTC — just after the app's own 02:00 housekeeping. Keep the server on UTC.)
set -euo pipefail
umask 077   # archives hold customer data: owner-only

cd "$(dirname "$0")"
# Read only what we need from .env. Never `source` it: values such as
# EMAIL_FROM=I&C Logistics Co. <no-reply@...> contain & and < which the shell
# would execute.
DB="$(grep -E '^DB_NAME=' .env 2>/dev/null | cut -d= -f2-)"
DB="${DB:-inc_logistics}"
OUT_DIR="${BACKUP_DIR:-/opt/inc-logistics/backups}"
KEEP_HERE=3            # nightly archives on this server once offsite works
KEEP_HERE_NO_OFFSITE=14
KEEP_OFFSITE=90d
NAME="${BACKUP_NAME:-$(date -u +%Y%m%dT%H%M%SZ)}"
ARCHIVE="$OUT_DIR/${DB}-${NAME}.archive.gz"

mkdir -p "$OUT_DIR"

# Dump to a temporary name, so a failed dump never replaces a good archive.
docker compose exec -T mongo sh -c \
  "mongodump --username \"\$MONGO_INITDB_ROOT_USERNAME\" \
             --password \"\$MONGO_INITDB_ROOT_PASSWORD\" \
             --authenticationDatabase admin \
             --db \"$DB\" --archive --gzip" > "$ARCHIVE.part"

# Fail loudly if the archive came out empty.
if [ ! -s "$ARCHIVE.part" ]; then
  echo "ERROR: backup is empty: $ARCHIVE" >&2
  rm -f "$ARCHIVE.part"
  exit 1
fi
mv -f "$ARCHIVE.part" "$ARCHIVE"

echo "$(date -u +%FT%TZ)  backup ok: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"

# A named archive (pre-deploy) is not copied offsite and not counted below.
[ -z "${BACKUP_NAME:-}" ] || exit 0

# ─── Offsite copy ──────────────────────────────────────────────────────────────
keep=$KEEP_HERE_NO_OFFSITE
if ! command -v rclone >/dev/null || ! rclone listremotes 2>/dev/null | grep -qx 'offsite:'; then
  echo "offsite: not set up; keeping the newest $keep here"
elif rclone copy "$ARCHIVE" offsite: && rclone delete offsite: --min-age "$KEEP_OFFSITE"; then
  echo "offsite: copied to R2"
  keep=$KEEP_HERE
else
  echo "WARNING: offsite copy failed; keeping the newest $keep here" >&2
fi

# Keep the newest $keep timestamped archives on this server.
ls -1t "$OUT_DIR/$DB"-2*.archive.gz 2>/dev/null | tail -n "+$((keep + 1))" | xargs -r rm -f || true
