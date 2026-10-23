#!/usr/bin/env bash
# Nightly database backup, run by cron on the Hetzner host.
#
# Dumps the whole database straight out of the running mongo container to a
# single gzipped archive (mongodump, which ships inside the mongo image), keeps
# 14 days locally, and — if configured — copies each archive offsite.
#
# Restore one with:
#   gunzip -c inc_logistics-STAMP.archive.gz | \
#     docker compose exec -T mongo sh -c \
#       'mongorestore --username "$MONGO_INITDB_ROOT_USERNAME" \
#          --password "$MONGO_INITDB_ROOT_PASSWORD" \
#          --authenticationDatabase admin --archive --gzip --drop'
#
# Install (as the deploy user):
#   chmod +x deploy/hetzner/backup.sh
#   crontab -e
#   17 2 * * *  cd /opt/inc-logistics/deploy/hetzner && ./backup.sh >> /var/log/inc-backup.log 2>&1
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
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="$OUT_DIR/${DB}-${STAMP}.archive.gz"

mkdir -p "$OUT_DIR"

docker compose exec -T mongo sh -c \
  "mongodump --username \"\$MONGO_INITDB_ROOT_USERNAME\" \
             --password \"\$MONGO_INITDB_ROOT_PASSWORD\" \
             --authenticationDatabase admin \
             --db \"$DB\" --archive --gzip" > "$ARCHIVE"

# Fail loudly if the archive came out empty.
if [ ! -s "$ARCHIVE" ]; then
  echo "ERROR: backup is empty: $ARCHIVE" >&2
  rm -f "$ARCHIVE"
  exit 1
fi

find "$OUT_DIR" -name "${DB}-*.archive.gz" -mtime "+${KEEP_DAYS}" -delete

echo "$(date -u +%FT%TZ)  backup ok: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"

# ─── Offsite copy (recommended) ────────────────────────────────────────────────
# A backup on the same server is not a backup. Uncomment one:
#
# Hetzner Storage Box over SSH/rsync:
#   rsync -az -e "ssh -p 23" "$ARCHIVE" u123456@u123456.your-storagebox.de:backups/
#
# Or rclone to any remote (S3, Backblaze, Google Drive, ...):
#   rclone copy "$ARCHIVE" myremote:inc-logistics-backups/
