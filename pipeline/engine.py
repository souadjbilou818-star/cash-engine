#!/usr/bin/env python3
"""Cash Engine: find Paris businesses with no site (or a bad one), build each a demo,
push it live, and line up the outreach. Standard library only.

  python3 pipeline/engine.py run              # daily: find -> qualify -> write -> push
  python3 pipeline/engine.py run --dry        # everything except pushing (writes data/preview.json)
  python3 pipeline/engine.py send             # preview today's emails (no send)
  python3 pipeline/engine.py send --really    # send them (capped, spaced out)
  python3 pipeline/engine.py stats
"""
import argparse
import json
import random
import re
import secrets
import smtplib
import sys
import time
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import DATA, env, env_int, http_json, load_env, log  # noqa: E402
import copywriter  # noqa: E402
import llm  # noqa: E402
import sirene  # noqa: E402
import sources  # noqa: E402
import verify  # noqa: E402


# ---------------- Worker API ----------------
def api(method, path, data=None):
    base = env("WORKER_URL").rstrip("/")
    if not base or not env("ADMIN_KEY"):
        raise SystemExit("Set WORKER_URL and ADMIN_KEY in .env first.")
    st, body = http_json(method, base + path, data, {"Authorization": f"Bearer {env('ADMIN_KEY')}"}, timeout=60)
    if st != 200:
        raise RuntimeError(f"Worker {method} {path} -> HTTP {st}: {str(body)[:200]}")
    return body


def norm_phone(p):
    d = re.sub(r"[^\d+]", "", p or "")
    if d.startswith("+"):
        return d[1:]
    if d.startswith("00"):
        return d[2:]
    if d.startswith("0"):
        return "33" + d[1:]
    return d


def is_mobile(p):
    return bool(re.match(r"^33[67]\d{8}$", norm_phone(p)))


def score(lead):
    s = lead["weight"] * 10
    s += 15 if is_mobile(lead.get("phone")) else (8 if lead.get("phone") else 0)
    s += 10 if lead.get("email") else 0
    s += 5 if lead.get("hours") else 0
    s += 3 if lead.get("instagram") else 0
    a = lead.get("audit") or {}
    if lead.get("opened_on"):
        import datetime as dt
        try:
            age = (dt.date.today() - dt.date.fromisoformat(lead["opened_on"])).days
            s += 25 if age <= 90 else (12 if age <= 180 else 0)
        except ValueError:
            pass
    if lead.get("kind") == "no_site":
        s += 8
    if a.get("viewport") is False:
        s += 10
    if a.get("score") is not None and a["score"] < 30:
        s += 5
    return s


# ---------------- run ----------------
def cmd_run(args):
    cats = [c.strip() for c in (args.cats or env("CATEGORIES", sources.DEFAULT_CATS)).split(",") if c.strip()]
    bad = [c for c in cats if c not in sources.CATEGORIES]
    if bad:
        raise SystemExit(f"Unknown categories: {bad}. Options: {', '.join(sources.CATEGORIES)}")
    postcodes = {p.strip() for p in (args.postcodes or env("POSTCODES")).split(",") if p.strip()}
    daily = args.max or env_int("DAILY_MAX", 60)

    known, suppressed = set(), set()
    offline = args.dry or args.fixture or args.sirene_fixture
    if not offline:
        k = api("GET", "/api/known")
        known, suppressed = set(k["osm_ids"]), set(k["suppress"])
        log(f"worker: {len(known)} leads already known, {len(suppressed)} opt-outs")

    want = {x.strip() for x in (args.sources or env("LEAD_SOURCES", "osm,sirene")).split(",") if x.strip()}
    raw = []
    if "osm" in want:
        if args.fixture:
            elements = json.loads(Path(args.fixture).read_text())["elements"]
        else:
            elements = sources.fetch_overpass(cats, env("AREA_NAME", "Paris"), env("AREA_ADMIN_LEVEL", "8"))
        log(f"osm: {len(elements)} raw places")
        for el in elements:
            l = sources.normalize(el)
            if l and (l["cat_key"] in cats or (l["cat_key"] == "barber" and "hairdresser" in cats)):
                l["source"] = "osm"
                raw.append(l)
    if "sirene" in want:
        if args.sirene_fixture:
            data = json.loads(Path(args.sirene_fixture).read_text())
            import datetime as dt
            cutoff = (dt.date.today() - dt.timedelta(days=env_int("SIRENE_DAYS", 180))).isoformat()
            raw_s = [x for r in data["results"] for x in sirene.parse_result(r, r["_pc"], r["_naf"], cutoff)]
        else:
            raw_s = sirene.fetch(sorted(postcodes) or None)
        # same shop in both sources: keep OSM (has phone), add the opening date
        by_key = {(verify.slugify(l["name"]), l["postcode"]): l for l in raw}
        for l in raw_s:
            twin = by_key.get((verify.slugify(l["name"]), l["postcode"]))
            if twin:
                twin["opened_on"] = l["opened_on"]
            else:
                raw.append(l)

    leads, seen = [], set()
    for l in raw:
        if postcodes and l["postcode"] not in postcodes:
            continue
        if l["osm_id"] in known or l["osm_id"] in seen:
            continue
        if (l["phone"] and norm_phone(l["phone"]) in suppressed) or (l["email"] and l["email"] in suppressed):
            continue
        seen.add(l["osm_id"])
        leads.append(l)
    log(f"filter: {len(leads)} new independents ({sum(l['source']=='sirene' for l in leads)} recently opened, from the registry)")

    # qualify the most promising first (pre-score without audit), cap the work per day
    leads.sort(key=lambda l: (score(l), random.random()), reverse=True)
    batch = leads[: daily * 3]
    log(f"qualify: checking {len(batch)} (domain guesses{', Gemini search' if env('GEMINI_API_KEY') else ''}, site audits)")
    qualified = verify.qualify_all(batch)
    for l in qualified:  # enrichment may have found a contact that opted out earlier
        if (l.get("phone") and norm_phone(l["phone"]) in suppressed) or (l.get("email") and l["email"] in suppressed):
            l["kind"] = "skip"
    pitch = [l for l in qualified if l["kind"] in ("no_site", "weak_site")]
    skips = [l for l in qualified if l["kind"] == "skip"]
    for l in pitch:
        l["score"] = score(l)
    pitch.sort(key=lambda l: l["score"], reverse=True)
    pitch = pitch[:daily]
    log(f"qualify: {sum(l['kind']=='no_site' for l in pitch)} no site, {sum(l['kind']=='weak_site' for l in pitch)} weak site, {len(skips)} fine (skipped)")

    router = llm.Router()
    sources_used = {"llm": 0, "fallback": 0}
    out = []
    for i, l in enumerate(pitch, 1):
        site, src = copywriter.site_copy(router, l)
        sources_used[src] += 1
        l["content"] = {"site": site, "outreach": copywriter.outreach(l)}
        l["slug"] = f"{verify.slugify(l['name'])[:40].strip('-')}-{secrets.token_hex(2)}"
        out.append(l)
        if i % 10 == 0:
            log(f"write: {i}/{len(pitch)}")
    log(f"write: {sources_used['llm']} by LLM {router.calls}, {sources_used['fallback']} fallback copy")
    log(f"reach: {sum(bool(l.get('email')) for l in out)} by email (automatic), "
        f"{sum(bool(l.get('phone')) and not l.get('email') for l in out)} phone only, "
        f"{sum(not l.get('phone') and not l.get('email') for l in out)} walk-in only")

    for l in skips:  # remember them so we never re-audit
        l["slug"] = f"x-{secrets.token_hex(6)}"

    payload = [_row(l) for l in out + skips]
    if offline:
        (DATA / "preview.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2))
        log(f"dry run: wrote {len(payload)} rows to data/preview.json")
        return payload
    for i in range(0, len(payload), 100):
        api("POST", "/api/leads", {"leads": payload[i:i + 100]})
    base = env("WORKER_URL").rstrip("/")
    log(f"pushed {len(out)} demos live (+{len(skips)} skips). Hit list: {base}/admin")
    for l in out[:5]:
        log(f"  {l['name']:<32} {base}/s/{l['slug']}")
    return payload


def _row(l):
    return {
        "slug": l["slug"], "osm_id": l["osm_id"], "name": l["name"], "category": l["category"], "cat_key": l["cat_key"],
        "theme": l["theme"], "kind": l["kind"], "address": l["address"], "postcode": l["postcode"], "city": l["city"],
        "lat": l["lat"], "lon": l["lon"], "phone": l["phone"], "email": l["email"], "instagram": l["instagram"],
        "facebook": l["facebook"], "website": l.get("website"), "hours": l["hours"], "audit": l.get("audit"),
        "content": l.get("content"), "score": l.get("score", 0),
        "source": l.get("source"), "opened_on": l.get("opened_on"),
    }


# ---------------- send ----------------
STEP_TEMPLATE = {"initial": "email_body", "bump": "email_bump", "opened": "email_opened", "last": "email_last"}


def build_email(item, base, default_expiry):
    """item comes from /api/outbox: slug, name, email, content, step, kind_of_email, msgid"""
    o = json.loads(item["content"]).get("outreach", {})
    url, stop = f"{base}/s/{item['slug']}", f"{base}/stop/{item['slug']}"
    expiry = item.get("expiry") or default_expiry
    fill = lambda t: t.replace("{url}", url).replace("{stop}", stop).replace("{expiry}", expiry)
    first_subject = fill(o.get("email_subject", item["name"]))
    body = fill(o.get(STEP_TEMPLATE[item["which"]], "") or o.get("email_body", ""))
    subject = first_subject if item["which"] == "initial" else f"Re: {first_subject}"
    m = EmailMessage()
    m["From"] = formataddr((env("FROM_NAME", env("AGENCY_PERSON", "")), env("FROM_EMAIL")))
    m["To"] = item["email"]
    m["Subject"] = subject
    if env("REPLY_DOMAIN"):  # replies land in the Worker's AI inbox
        m["Reply-To"] = formataddr((env("FROM_NAME", env("AGENCY_PERSON", "")), f"reply+{item['slug']}@{env('REPLY_DOMAIN')}"))
    msgid = make_msgid(domain=(env("REPLY_DOMAIN") or env("FROM_EMAIL").split("@")[-1]))
    m["Message-ID"] = msgid
    if item.get("msgid"):
        m["In-Reply-To"] = item["msgid"]
        m["References"] = item["msgid"]
    m["List-Unsubscribe"] = f"<{stop}>"
    m.set_content(body)
    return m, msgid


def cmd_send(args):
    cap = args.cap or env_int("EMAIL_DAILY_CAP", 25)
    box = api("GET", f"/api/outbox?limit={cap}")
    base = env("WORKER_URL").rstrip("/")
    items = box["items"]
    if not items:
        log("outbox: nothing due today (first emails + follow-ups). Phone and walk-in leads are on the hit list.")
        return
    msgs = [(it, *build_email(it, base, box["expiry"])) for it in items]
    counts = {}
    for it, _, _ in msgs:
        counts[it["which"]] = counts.get(it["which"], 0) + 1
    if not args.really:
        for it, m, _ in msgs[:3]:
            print(f"\n=== [{it['which']}] To: {m['To']}\nSubject: {m['Subject']}\nReply-To: {m['Reply-To']}\n\n{m.get_content()}")
        print(f"[preview] {len(msgs)} due: {counts}. Add --really to send (cap {cap}/day, 40-120 s apart).")
        return
    for k in ("SMTP_HOST", "SMTP_USER", "SMTP_PASS", "FROM_EMAIL"):
        if not env(k):
            raise SystemExit(f"Missing {k} in .env")
    sent = []
    with smtplib.SMTP(env("SMTP_HOST"), env_int("SMTP_PORT", 587), timeout=60) as s:
        s.starttls()
        s.login(env("SMTP_USER"), env("SMTP_PASS"))
        for i, (it, m, msgid) in enumerate(msgs):
            try:
                s.send_message(m)
                sent.append({"slug": it["slug"], "which": it["which"], "msgid": it.get("msgid") or msgid})
                log(f"sent {i+1}/{len(msgs)} [{it['which']}] -> {it['name']}")
            except smtplib.SMTPException as e:
                log(f"failed -> {it['email']}: {e}")
            if i < len(msgs) - 1:
                time.sleep(random.uniform(40, 120))
    if sent:
        api("POST", "/api/emailed", {"items": sent})
    log(f"done: {len(sent)} sent {counts}")


def cmd_stats(args):
    print(json.dumps(api("GET", "/api/stats"), indent=2, ensure_ascii=False))


def main():
    load_env()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--cats", help="comma list, default from CATEGORIES")
    r.add_argument("--postcodes", help="e.g. 75011,75020 (default: all of Paris)")
    r.add_argument("--max", type=int, help="demos to build today (default DAILY_MAX=60)")
    r.add_argument("--dry", action="store_true", help="don't push, write data/preview.json")
    r.add_argument("--fixture", help="use a saved Overpass JSON instead of the API (implies --dry)")
    r.add_argument("--sirene-fixture", help="saved registry JSON for tests")
    r.add_argument("--sources", help="osm,sirene (default LEAD_SOURCES)")
    s = sub.add_parser("send")
    s.add_argument("--really", action="store_true")
    s.add_argument("--cap", type=int)
    sub.add_parser("stats")
    a = ap.parse_args()
    {"run": cmd_run, "send": cmd_send, "stats": cmd_stats}[a.cmd](a)


if __name__ == "__main__":
    main()
