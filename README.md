# Cash Engine v2: autonomous

Finds independent Paris businesses with **no website** (or a broken one), with priority on shops that **just opened**,
builds each one **its own demo site**, emails them a threaded sequence, answers their questions with an **AI closer**,
takes **payment**, and puts the paid site **live within seconds**. Your phone buzzes at every step that matters.

```
06:23  GitHub Actions
       ├─ OpenStreetMap ─┐
       ├─ SIRENE registry ┼─► qualify ─► enrich (own site + Gemini/Google, cited only) ─► LLM copy ─► 60 demos live
       └─ (recently opened shops)
       └─ email sequence: first email, bump, "opened" nudge, last call (threaded, capped, opt-out in each)
all day   Worker (Cloudflare, serverless, always on)
       ├─ demo opened ─────────────► 📱 push "appelle maintenant"
       ├─ AI closer chat on demo ──► answers price/delay/photos, captures phone ─► 📱
       ├─ email reply ─────────────► AI inbox: STOP = blacklisted · oui/question = AI answers in thread ─► 📱
       ├─ Stripe payment ──────────► won · site live on <name>.yourdomain.fr · thank-you + photos page ─► 📱 💸
       └─ cancellation ────────────► site suspended ─► 📱
20:00  📱 digest: opens, questions, replies, callbacks, € today, active clients
```

### What's automatic, and what isn't

| Automatic | Still you (optional, but it's where extra money is) |
|---|---|
| Lead search, qualification, enrichment | Calling the 🔥 pushes within 5 min |
| Demo sites, copy, hit list | WhatsApp/SMS to mobiles (1 tap, prefilled) |
| Email + 3 follow-ups to published addresses | Walk-ins for shops with no phone/email (script on the card) |
| Answering replies and chat questions | Custom domains for clients who want one |
| Payment, delivery, suspension, digest | Swapping in the client's photos after payment |

Calls, SMS and WhatsApp stay human on purpose: automated calls and SMS need prior consent in France, and WhatsApp
bans bulk senders. Only a minority of shops publish an email, so the fully automatic channel is the smallest one.
The engine makes up for it by finding more leads, and by making your few minutes on the phone count.

---

## Fastest setup: one script

On Instabox (or any Linux/Mac): clone this repo, then `bash setup.sh`. It installs what's missing, deploys the
Worker to your Cloudflare account, creates the database, generates your admin key and alert topic, runs a first real
hunt, and switches on the GitHub autopilot if `gh` is signed in. It asks only for what it can't create itself:
your name and prices, a Cloudflare API token + account ID, and free AI keys. Safe to re-run.

Stripe, the domain and the AI inbox are switched on afterwards (sections 0, 3 and 4 below).

## Setup by hand

### 0. One thing you buy: a domain (~10 €/year)

Replies, client sites and trust all hang on it. Buy something like `studiorive.fr` and add it to Cloudflare
(Cloudflare Registrar sells at cost). Everything else stays on free tiers. Stripe takes its usual fee per payment.

### 1. Worker (≈15 min)

```bash
cd worker
npx wrangler login
npx wrangler d1 create cash-engine            # paste database_id into wrangler.toml
npx wrangler d1 execute cash-engine --remote --file=schema.sql
#   (already ran v1? run migrations/002_autonomy.sql instead)
# edit [vars] in wrangler.toml: identity, price, PUBLIC_URL, CLIENT_ZONE, REPLY_DOMAIN, FORWARD_TO
npx wrangler secret put ADMIN_KEY              # openssl rand -hex 24
npx wrangler secret put NTFY_TOPIC             # random, e.g. cash-7f3k9q2m
npx wrangler deploy
```

- **Demo host:** in the Cloudflare dashboard, add the Custom Domain `demo.studiorive.fr` to the Worker, then set
  `PUBLIC_URL = "https://demo.studiorive.fr"` and `DEMO_HOST = "demo.studiorive.fr"`.
  Demos on your own domain look more trustworthy and land in inboxes more often than `workers.dev` links.
- **Client sites:** add a proxied DNS record `*` → `AAAA 100::`, uncomment the `routes` wildcard in `wrangler.toml`,
  set `CLIENT_ZONE = "studiorive.fr"`, deploy. A paid client goes live on `le-comptoir-de-lea.studiorive.fr` instantly.
- **AI:** the `[ai]` binding is already there. Workers AI has a free daily allowance; if it runs out, the chat and
  inbox fall back to scripted answers and drafts, so nothing goes silent.

### 2. Phone (2 min)

ntfy app → subscribe to `NTFY_TOPIC`. Open `PUBLIC_URL/admin?k=ADMIN_KEY` once → "Add to home screen".

### 3. AI inbox (≈10 min)

Cloudflare dashboard → your domain → **Email Routing**: enable it (it adds the MX/SPF records), add your real inbox as a
destination and verify it, then set the **catch-all** action to *Send to a Worker* → `cash-engine`.
In `wrangler.toml`: `REPLY_DOMAIN = "studiorive.fr"`, `FORWARD_TO = "you@…"`, `AUTO_REPLY = "1"`.

Outgoing emails carry `Reply-To: reply+<lead>@studiorive.fr`, so every answer lands in the Worker, which:
- **STOP / pas intéressé** → blacklists the email + phone, no reply.
- **Out of office** → ignored.
- **Oui / question / rappelez-moi** → lead 🔥, push to you, and the AI closer answers in the same thread, with the
  payment link when they're ready. Every reply says it was written by an AI and carries the opt-out link.
- A copy of everything goes to `FORWARD_TO`. Cloudflare only lets the Worker reply to senders with valid DMARC;
  when it can't, the AI's draft waits on the hit list with a one-tap "Envoyer".

Start with `AUTO_REPLY = "0"` for a few days if you want to read the drafts first.

### 4. Stripe (≈10 min)

1. Products: **Site vitrine** (one-time 390 €) + **Hébergement & modifications** (monthly 19 €).
2. Payment Link with both items. *After payment* → redirect to `PUBLIC_URL/merci?session_id={CHECKOUT_SESSION_ID}`.
   Put the link in `CHECKOUT_URL`. Each demo appends `client_reference_id=<lead>` automatically.
3. Developers → Webhooks → endpoint `PUBLIC_URL/stripe/webhook`, events `checkout.session.completed`,
   `customer.subscription.deleted`, `invoice.payment_failed` → `npx wrangler secret put STRIPE_WEBHOOK_SECRET`.

You need a legal status to invoice (micro-entreprise is enough).

### 5. Pipeline + autopilot (≈10 min)

```bash
cp .env.example .env     # WORKER_URL = PUBLIC_URL, ADMIN_KEY, identity, ≥1 LLM key, GEMINI_API_KEY for search
python3 pipeline/engine.py run --dry --postcodes 75011 --max 10     # check data/preview.json
python3 pipeline/engine.py run --postcodes 75010,75011,75020
python3 pipeline/engine.py send                                     # preview what's due
```

Push the folder to a **private** GitHub repo, add the `.env` values (keys as secrets, the rest as variables),
and set the variable `SEND_EMAILS = 1`. From then on it runs Monday to Saturday at 06:23 Paris time with no one at the keyboard.
Use a separate mailbox for sending (Gmail + app password works), keep `EMAIL_DAILY_CAP` around 25.

Instabox, OpenCode or your laptop can run the same commands by hand; nothing needs to stay switched on.

---

## Lead search

| Source | What it adds | Notes |
|---|---|---|
| OpenStreetMap (Overpass) | Phones, hours, emails sometimes | Chains dropped (brand tags) |
| SIRENE registry (recherche-entreprises.api.gouv.fr) | **Shops opened in the last `SIRENE_DAYS` days**, all of them, official | Storefront activities only; sole traders without a shop sign and non-diffusible entries skipped; chains (>3 sites) skipped |
| Their own website | Phone and email from `tel:` / `mailto:` links | Published by them |
| Gemini + Google Search | Missing site / phone / email / Instagram | A phone or email is kept **only if it sits in a passage Google grounding ties to a web source**: no invented numbers, no guessed addresses |

Fresh openings score highest and get their own pitch ("félicitations pour l'ouverture"). Leads with no phone or
email still get a demo and a walk-in script.

Not scraped, on purpose: Google Maps, PagesJaunes, Instagram. Their terms forbid it, they ban the accounts and IPs
that do it, and the registry already tells you who opened last month, which they can't.

NAF codes are the rev. 2 ones. INSEE switches to NAF 2025 in January 2027: update `NAF` in `pipeline/sirene.py` then.

## Closing levers (wrangler.toml)

- `OFFER_GUARANTEE`: e.g. "remboursé sous 14 jours si le site ne vous convient pas". The AI states it, so only set what you honour.
- `OFFER_CONCESSION`: the one gesture the AI may offer when someone hesitates on price (e.g. "le premier mois offert"). Empty = no discounts, ever.
- `OFFER_INCLUDES`: extra facts the AI may state.
- The AI only knows these facts. It can't invent prices, results or Google rankings, and it backs off after a clear no.

## Your 15 minutes a day

1. 📱 push "ouvre sa démo / veut être rappelé / regarde le prix / ouvre le paiement" → **call**.
2. Hit list → 🔥 Chaud: read what the AI said, follow up.
3. After a 💸 push: get their photos on WhatsApp, paste them into "Modifier".

## Legal notes (France / EU)

- B2B email: allowed without prior consent if it relates to their business, identifies you and offers an opt-out.
  Every email does all three; `/stop/<lead>` and "STOP" replies blacklist them for good.
- Business phone calls are outside the consumer opt-in rule in force since 11 August 2026; automated calls and SMS still need consent, so none are automated here.
- The chat and email agent say they're an AI from the first message (EU AI Act art. 50, applicable since 2 August 2026).
- Demos are `noindex`, labelled "non officielle", and self-destruct; invented facts are filtered out of the copy.
- Registry data is personal data for sole traders: their names never appear on demos, non-diffusible entries are skipped.
- Health professions excluded (regulated advertising).

## Tests (88 checks, offline)

```bash
LLM_MOCK=1 VERIFY_WITH_GEMINI=0 python3 pipeline/engine.py run --fixture tests/fixture_overpass.json --sirene-fixture tests/fixture_sirene.json
python3 tests/test_pipeline.py            # 26: parsing, guards, registry, grounding check, sequence copy
node --no-warnings tests/test_worker.mjs  # 34: demos, tracking, hit list, opt-out, live domains
node --no-warnings tests/test_autonomy.mjs # 28: AI closer, follow-ups, AI inbox, Stripe, delivery, churn, digest
```

Lead data © OpenStreetMap contributors (ODbL) · SIRENE © INSEE (Licence Ouverte).
