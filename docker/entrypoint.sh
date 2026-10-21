#!/bin/sh
set -e

# Seed demo history once, and only when asked, so a `docker compose up` shows a
# populated page immediately without ever overwriting real data.
if [ "${SEED_ON_START:-0}" = "1" ]; then
  echo "seeding demo data (skipped automatically if monitors already exist)"
  node dist/seed.js || echo "seed failed, continuing with an empty database"
fi

exec "$@"
