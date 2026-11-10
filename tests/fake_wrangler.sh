#!/usr/bin/env bash
# Stand-in for wrangler in tests/test_setup.sh (prints what the real CLI prints).
case "$1 ${2:-}" in
  "whoami "*) echo "You are logged in with an API Token, associated with the email sami@example.com.";;
  "d1 create") echo "✅ Successfully created DB 'cash-engine' in region WEUR"; echo "[[d1_databases]]"; echo 'database_id = "11111111-2222-3333-4444-555555555555"';;
  "d1 execute") echo "🚣 Executed 9 commands in 1.2ms";;
  "deploy "*) echo "Uploaded cash-engine (3.1 sec)"; echo "Deployed cash-engine triggers (0.9 sec)"; echo "  https://cash-engine.sami-test.workers.dev"; echo "  schedule: 0 19 * * *";;
  "secret put") cat >/dev/null; echo "✨ Success! Uploaded secret $3";;
  *) echo "fake wrangler: unhandled $*" >&2; exit 1;;
esac
