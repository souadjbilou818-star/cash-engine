#!/usr/bin/env bash
# Cash Engine: one-command setup. Run it on Instabox (or any Linux/Mac with internet):
#   bash setup.sh
# Safe to re-run: it resumes, skips what's done, and keeps your answers in .env (chmod 600).
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$PWD
B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
step() { printf "\n${B}▸ %s${N}\n" "$*"; }
ok()   { printf "${G}✓${N} %s\n" "$*"; }
warn() { printf "${Y}!${N} %s\n" "$*"; }
die()  { printf "${R}✗ %s${N}\n" "$*" >&2; exit 1; }

# French keyboards + web terminals: make sure accents and backspace behave
case "${LC_ALL:-${LANG:-}}" in
  *[Uu][Tt][Ff]*) ;;
  *) if locale -a 2>/dev/null | grep -qiE '^c\.utf-?8$'; then export LANG=C.UTF-8 LC_ALL=C.UTF-8; fi ;;
esac
export PYTHONUTF8=1
if [ -t 0 ]; then stty iutf8 2>/dev/null || true; fi

touch .env && chmod 600 .env
getv() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- || true; }
setv() {  # setv KEY VALUE  (writes .env atomically, exports the cleaned value)
  local clean
  clean=$(python3 - "$1" "$2" <<'PY'
import os, re, sys, pathlib
k = sys.argv[1]
# half-erased accents (e.g. a stray byte from "à") and control chars are dropped, not saved
v = sys.argv[2].encode("utf-8", "surrogateescape").decode("utf-8", "ignore")
v = re.sub(r"[\x00-\x1f\x7f]", "", v).strip()
p = pathlib.Path(".env"); lines = p.read_text(encoding="utf-8", errors="ignore").splitlines() if p.exists() else []
out, done = [], False
for l in lines:
    if l.startswith(k + "="):
        if not done: out.append(f"{k}={v}"); done = True
    else: out.append(l)
if not done: out.append(f"{k}={v}")
tmp = p.with_suffix(".tmp"); tmp.write_text("\n".join(out) + "\n", encoding="utf-8"); os.chmod(tmp, 0o600); tmp.replace(p)
print(v)
PY
) || die "Could not save $1 to .env"
  export "$1=$clean"
}
ask() {  # ask KEY "Question" [default] [secret]
  local k=$1 q=$2 def=${3:-} secret=${4:-} cur val
  cur="${!k:-}"; [ -z "$cur" ] && cur=$(getv "$k")
  if [ -n "$cur" ]; then setv "$k" "$cur"; return; fi
  if [ ! -t 0 ]; then setv "$k" "$def"; return; fi
  if [ -n "$secret" ]; then read -rsp "  $q${def:+ [$def]}: " val; echo; else read -erp "  $q${def:+ [$def]}: " val; fi
  setv "$k" "${val:-$def}"
}
toml_var() {  # toml_var KEY VALUE -> sets KEY = "VALUE" under [vars] in worker/wrangler.toml
  python3 - "$1" "$2" <<'PY'
import re, sys, pathlib
k = sys.argv[1]
v = sys.argv[2].encode("utf-8", "surrogateescape").decode("utf-8", "ignore").replace('"', '\\"')
p = pathlib.Path("worker/wrangler.toml"); s = p.read_text()
pat = re.compile(rf'^({re.escape(k)}\s*=\s*)"[^"\n]*"', re.M)
s = pat.sub(lambda m: f'{m.group(1)}"{v}"', s, count=1) if pat.search(s) else s.replace("[vars]\n", f'[vars]\n{k} = "{v}"\n', 1)
p.write_text(s)
PY
}
rand() { python3 -c "import secrets,sys; print(sys.argv[1] + secrets.token_hex(int(sys.argv[2])))" "$1" "$2"; }

# ---------------------------------------------------------------- 1. tools
step "1/7 Tools"
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$PATH"
need_node=1
if command -v node >/dev/null; then
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] && need_node=0
fi
if [ $need_node = 1 ]; then
  warn "Node 20+ not found, installing Node 22 in ~/.local/node (no root needed)"
  arch=$(uname -m); case $arch in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; esac
  os=linux; [ "$(uname)" = Darwin ] && os=darwin
  file=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep -oE "node-v[0-9.]+-$os-$arch\.tar\.gz" | head -1)
  [ -n "$file" ] || die "Could not find a Node build for $os-$arch"
  mkdir -p "$HOME/.local/node" && curl -fsSL "https://nodejs.org/dist/latest-v22.x/$file" | tar xz -C "$HOME/.local/node" --strip-components 1
fi
command -v python3 >/dev/null || die "python3 is required"
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' || die "Python 3.10+ required"
ok "node $(node -v), python $(python3 -V | cut -d' ' -f2)"
WR="npx -y wrangler@4"
[ -n "${WRANGLER:-}" ] && WR=$WRANGLER   # tests

# ---------------------------------------------------------------- 2. you
step "2/7 Who you are (shown on demos and in every message)"
ask AGENCY_NAME   "Trading name" "Studio Rive"
ask AGENCY_PERSON "Your first name (signs the messages)" "Sami"
fr_phone() { python3 -c '
import re, sys
d = re.sub(r"\D", "", sys.argv[1])
if d.startswith("33") and len(d) == 11: d = "0" + d[2:]
print(" ".join(d[i:i+2] for i in range(0, 10, 2)) if re.fullmatch(r"0[1-9]\d{8}", d) else "")' "$1"; }
while :; do
  ask AGENCY_PHONE "Your phone, e.g. 07 51 19 96 11" ""
  p=$(fr_phone "$AGENCY_PHONE")
  if [ -n "$p" ]; then setv AGENCY_PHONE "$p"; break; fi
  warn "That doesn't look like a French number (10 digits starting with 0). Try again."
  setv AGENCY_PHONE ""; unset AGENCY_PHONE
  [ -t 0 ] || die "AGENCY_PHONE missing"
done
ask OFFER_PRICE   "Setup price" "390 €"
ask OFFER_MONTHLY "Monthly price" "19 €/mois"
ask OFFER_DELAY   "Delivery delay" "48 h"
ask POSTCODES     "Arrondissements to hunt (start with 2-3 you can walk)" "75010,75011,75020"
ask DAILY_MAX     "Demos per day" "40"

# ---------------------------------------------------------------- 3. cloudflare
step "3/7 Cloudflare"
if [ -z "$(getv CLOUDFLARE_API_TOKEN)" ] && [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  cat <<EOF
  Create a token: dash.cloudflare.com → My Profile → API Tokens → Create Token
  → template "Edit Cloudflare Workers" → add permissions "Account · D1 · Edit" and "Account · Workers AI · Read" → Create.
  Account ID: dash.cloudflare.com → Workers & Pages → right column "Account ID".
  (First time on Workers? Open Workers & Pages once and pick your workers.dev subdomain.)
EOF
fi
ask CLOUDFLARE_API_TOKEN  "Cloudflare API token" "" secret
ask CLOUDFLARE_ACCOUNT_ID "Cloudflare account ID" ""
[ -n "$CLOUDFLARE_API_TOKEN" ] && [ -n "$CLOUDFLARE_ACCOUNT_ID" ] || die "Cloudflare token and account ID are required"
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
cd worker
$WR whoami </dev/null >/tmp/ce_whoami 2>&1 || { tail -5 /tmp/ce_whoami; die "Cloudflare rejected the token"; }
ok "Cloudflare token works"

DBID=$(grep -oE 'database_id = "[0-9a-f-]{36}"' wrangler.toml | grep -oE '[0-9a-f-]{36}' || true)
if [ -z "$DBID" ]; then
  out=$($WR d1 create cash-engine </dev/null 2>&1 || true)
  DBID=$(echo "$out" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)
  if [ -z "$DBID" ]; then  # already exists from an earlier run
    DBID=$($WR d1 list --json </dev/null 2>/dev/null | python3 -c 'import json,sys; print(next((d.get("uuid") or d.get("database_id") for d in json.load(sys.stdin) if d.get("name")=="cash-engine"), ""))' || true)
  fi
  [ -n "$DBID" ] || { echo "$out" | tail -8; die "Could not create the D1 database"; }
  sed -i.bak "s/PASTE_DATABASE_ID_HERE/$DBID/" wrangler.toml && rm -f wrangler.toml.bak
fi
ok "database $DBID"
$WR d1 execute cash-engine --remote --file=schema.sql </dev/null >/tmp/ce_schema 2>&1 || { tail -8 /tmp/ce_schema; die "Schema failed"; }
ok "tables ready"
cd "$ROOT"

# ---------------------------------------------------------------- 4. worker
step "4/7 Deploy the Worker"
for k in AGENCY_NAME AGENCY_PERSON AGENCY_PHONE OFFER_PRICE OFFER_MONTHLY OFFER_DELAY; do toml_var "$k" "${!k}"; done
cd worker
out=$($WR deploy </dev/null 2>&1) || { echo "$out" | tail -12; die "Deploy failed (new account? open Workers & Pages once to pick a workers.dev subdomain)"; }
URL=$(echo "$out" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1 || true)
[ -n "$URL" ] || URL=$(getv WORKER_URL)
[ -n "$URL" ] || { echo "$out" | tail -12; die "Deployed, but couldn't read the URL. Re-run with WORKER_URL=https://... bash setup.sh"; }
cd "$ROOT"
if ! grep -q "PUBLIC_URL    = \"$URL\"" worker/wrangler.toml; then
  toml_var PUBLIC_URL "$URL"
  (cd worker && $WR deploy </dev/null >/tmp/ce_deploy2 2>&1) || { tail -8 /tmp/ce_deploy2; die "Redeploy failed"; }
fi
setv WORKER_URL "$URL"
ok "live at $URL"

[ -n "$(getv ADMIN_KEY)" ] || setv ADMIN_KEY "$(rand '' 24)"
[ -n "$(getv NTFY_TOPIC)" ] || setv NTFY_TOPIC "$(rand cash- 6)"
ADMIN_KEY=$(getv ADMIN_KEY); NTFY_TOPIC=$(getv NTFY_TOPIC)
if [ "$(getv SECRETS_SET)" != "1" ]; then
  (cd worker && printf '%s' "$ADMIN_KEY" | $WR secret put ADMIN_KEY >/tmp/ce_s1 2>&1 && printf '%s' "$NTFY_TOPIC" | $WR secret put NTFY_TOPIC >/tmp/ce_s2 2>&1) \
    || { tail -5 /tmp/ce_s1 /tmp/ce_s2 2>/dev/null; die "Could not set Worker secrets"; }
  setv SECRETS_SET 1
fi
ok "secrets set"
if curl -fsS -m 15 -H "Authorization: Bearer $ADMIN_KEY" "$URL/api/stats" >/dev/null 2>&1; then ok "health check passed"; else warn "health check didn't answer yet (DNS for a new workers.dev name can take a minute)"; fi

# ---------------------------------------------------------------- 5. brains
step "5/7 AI keys (free tiers; Enter to skip one)"
echo "  Gemini: aistudio.google.com → Get API key. It also powers the Google-search enrichment."
ask GEMINI_API_KEY "Gemini API key" "" secret
ask NVIDIA_API_KEY "NVIDIA NIM key (build.nvidia.com, optional)" "" secret
ask GROQ_API_KEY   "Groq key (console.groq.com, optional)" "" secret
[ -n "$GEMINI_API_KEY$NVIDIA_API_KEY$GROQ_API_KEY" ] || warn "No LLM key: demos will use built-in copy (works, less personal)"
for k in LEAD_SOURCES=osm,sirene SIRENE_DAYS=180 VERIFY_WITH_GEMINI=1 VERIFY_MAX=80 EMAIL_DAILY_CAP=25 \
         LLM_PROVIDERS=gemini,nim,cloudflare,groq,openrouter AREA_NAME=Paris AREA_ADMIN_LEVEL=8; do
  [ -n "$(getv "${k%%=*}")" ] || setv "${k%%=*}" "${k#*=}"
done

# ---------------------------------------------------------------- 6. first hunt
step "6/7 First hunt (real data: OpenStreetMap + business registry)"
if [ -n "${SETUP_FIXTURES:-}" ]; then
  python3 pipeline/engine.py run --fixture tests/fixture_overpass.json --sirene-fixture tests/fixture_sirene.json
  ok "fixtures run (test mode)"
else
  python3 pipeline/engine.py run --dry --max 5 || die "Dry run failed (see above)"
  ok "dry run OK: 5 sample demos written to data/preview.json"
  go=y; [ -t 0 ] && read -rp "  Build and publish today's ${DAILY_MAX} demos now? [Y/n] " go
  if [ "${go:-y}" != "n" ]; then python3 pipeline/engine.py run || die "Run failed"; fi
fi

# ---------------------------------------------------------------- 7. autopilot
step "7/7 Autopilot (GitHub Actions runs the hunt every morning)"
repo=$(git remote get-url origin 2>/dev/null | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##' || true)
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1 && [ -n "$repo" ]; then
  for k in WORKER_URL ADMIN_KEY GEMINI_API_KEY NVIDIA_API_KEY GROQ_API_KEY SMTP_HOST SMTP_USER SMTP_PASS FROM_EMAIL PAGESPEED_API_KEY; do
    v=$(getv "$k"); [ -n "$v" ] && gh secret set "$k" -R "$repo" -b "$v" >/dev/null
  done
  for k in AGENCY_NAME AGENCY_PERSON AGENCY_PHONE OFFER_PRICE OFFER_MONTHLY OFFER_DELAY POSTCODES DAILY_MAX LEAD_SOURCES SIRENE_DAYS FROM_NAME REPLY_DOMAIN EMAIL_DAILY_CAP CATEGORIES; do
    v=$(getv "$k"); [ -n "$v" ] && gh variable set "$k" -R "$repo" -b "$v" >/dev/null
  done
  [ -n "$(getv SMTP_PASS)" ] && gh variable set SEND_EMAILS -R "$repo" -b 1 >/dev/null
  gh workflow enable daily-run -R "$repo" >/dev/null 2>&1 || true
  ok "GitHub secrets set on $repo: the hunt runs Mon-Sat 06:23 Paris"
else
  warn "GitHub CLI not signed in here, autopilot not switched on yet. Run: gh auth login, then bash setup.sh again."
fi

ADMIN_URL="$URL/admin?k=$ADMIN_KEY"
cat <<EOF

${G}${B}Done.${N}
  Hit list (open once on your phone, then "Add to home screen"):
    $ADMIN_URL
  Phone alerts: install the ntfy app → subscribe to topic:  ${B}$NTFY_TOPIC${N}

  To switch on the rest (README sections):
    • Stripe payments + instant delivery  → "4. Stripe"   (then: CHECKOUT_URL in worker/wrangler.toml, bash setup.sh)
    • AI inbox + automatic emails          → "0. domain" + "3. AI inbox" + SMTP_* in .env
  Your secrets are in $ROOT/.env (chmod 600). Never commit it.
EOF
