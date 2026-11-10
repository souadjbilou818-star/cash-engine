"""Qualify and enrich leads.

no_site   : no website in the data AND we can't find one (domain guesses + Gemini with Google Search).
weak_site : they have a site and we measured a concrete problem (no mobile layout, no HTTPS,
            PageSpeed mobile < 50, nothing updated for 4+ years, or it doesn't load).
skip      : they have a decent site.

Enrichment (the "search" part): fills missing phone / email / Instagram from
  1) their own website (tel: and mailto: links), and
  2) Gemini + Google Search, keeping a phone or email ONLY if it sits in a passage
     that Google grounding ties to a web source (no hallucinated numbers, no guessed emails).
Every reason we give a prospect is something we measured; nothing is invented.
"""
import re
import socket
import threading
import time
import unicodedata
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

from common import env, env_int, http, http_json, log
from sources import is_marketplace

socket.setdefaulttimeout(8)
GENERIC = {"le", "la", "les", "l", "de", "du", "des", "et", "chez", "au", "aux", "a", "paris", "the", "and", "sarl", "sas", "eurl"}
FR_PHONE = re.compile(r"(?:\+33\s?|0033\s?|0)[1-9](?:[\s.\-]?\d{2}){4}")
EMAIL = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
BAD_EMAIL = re.compile(r"(\.(png|jpe?g|gif|webp|svg)$|example\.|sentry|wixpress|@2x|domain\.com|email\.com|votre)", re.I)


def slugify(s, sep="-"):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", sep, s).strip(sep)


def digits(s):
    return re.sub(r"\D", "", s or "")


def clean_phone(p):
    d = digits(p)
    if d.startswith("33") and len(d) == 11:
        d = "0" + d[2:]
    return d if re.fullmatch(r"0[1-9]\d{8}", d) else ""


def fmt_phone(d):
    return " ".join(d[i:i + 2] for i in range(0, 10, 2)) if d else ""


def domain_guesses(name):
    words = [w for w in slugify(name, " ").split() if w]
    core = [w for w in words if w not in GENERIC] or words
    if not core or (len(core) == 1 and len(core[0]) < 5):
        return []  # too generic to guess safely ("Le Zinc")
    hy, cp = "-".join(core), "".join(core)
    out = []
    for base in dict.fromkeys([hy, cp]):
        out += [f"{base}.fr", f"{base}.com", f"{base}.paris", f"{base}-paris.fr"]
    return list(dict.fromkeys(out))


def _resolves(host):
    try:
        socket.getaddrinfo(host, 443)
        return True
    except OSError:
        return False


def page_matches(html, lead):
    """Is this page really this business? Needs a hard signal (phone or street + postcode)."""
    text = re.sub(r"\s+", " ", html).lower()
    ph = digits(lead.get("phone"))[-8:]
    if ph and ph in digits(text):
        return True
    street = slugify(lead.get("address", ""), " ")
    pc = lead.get("postcode", "")
    if pc and pc in text and street:
        toks = [t for t in street.split() if len(t) > 3 and not t.isdigit()]
        if toks and all(t in slugify(text, " ") for t in toks[:2]):
            return True
    return False


def fetch_page(url, timeout=8):
    try:
        st, body, _, final = http("GET", url, headers={"Accept": "text/html"}, timeout=timeout)
        if st >= 400:
            return None, final
        return body[:600_000].decode("utf-8", "replace"), final
    except Exception:
        return None, url


def contacts_from_html(html):
    phones = [clean_phone(urllib.parse.unquote(p)) for p in re.findall(r'href=["\']tel:([^"\']+)', html, re.I)]
    mails = [urllib.parse.unquote(m).split("?")[0] for m in re.findall(r'href=["\']mailto:([^"\']+)', html, re.I)]
    if not mails:
        mails = EMAIL.findall(re.sub(r"<[^>]+>", " ", html))
    mails = [m.lower().strip(".") for m in mails if EMAIL.fullmatch(m.strip(".")) and not BAD_EMAIL.search(m)]
    return [p for p in phones if p], list(dict.fromkeys(mails))


def find_site_by_guess(lead):
    for host in domain_guesses(lead["name"]):
        if not _resolves(host):
            continue
        for scheme in ("https://", "http://"):
            html, final = fetch_page(scheme + host)
            if html and page_matches(html, lead):
                return final
    return None


# ---------------- Gemini + Google Search grounding ----------------
def parse_lookup(text):
    out = {}
    for key, field in (("SITE", "website"), ("TEL", "phone"), ("EMAIL", "email"), ("INSTAGRAM", "instagram")):
        m = re.search(rf"^\W*{key}\W*:\s*(.+)$", text, re.M | re.I)
        if m:
            v = m.group(1).strip().strip("*`<> ")
            if v and not re.match(r"(aucun|none|null|n/?a|inconnu|-)\b", v, re.I):
                out[field] = v
    return out


def grounded_text(cand):
    gm = cand.get("groundingMetadata") or {}
    segs = [((s.get("segment") or {}).get("text") or "") for s in (gm.get("groundingSupports") or [])]
    return " ".join(segs)


def accept_cited(found, cited):
    """Keep phone/email only when they appear in a passage grounded in a web source."""
    res = {}
    if found.get("phone"):
        p = clean_phone(found["phone"])
        if p and p[-8:] in digits(cited):
            res["phone"] = fmt_phone(p)
    if found.get("email"):
        e = found["email"].lower()
        if EMAIL.fullmatch(e) and not BAD_EMAIL.search(e) and e in cited.lower():
            res["email"] = e
    if found.get("website", "").startswith("http") and not is_marketplace(found["website"]):
        res["website"] = found["website"]
    if "instagram.com/" in found.get("instagram", ""):
        res["instagram"] = found["instagram"]
    return res


def gemini_lookup(lead):
    key = env("GEMINI_API_KEY")
    if not key or env("VERIFY_WITH_GEMINI", "1") != "1":
        return {}
    model = env("GEMINI_VERIFY_MODEL", env("GEMINI_MODEL", "gemini-2.5-flash"))
    prompt = (
        f"Commerce : « {lead['name']} », {lead['category']}, {lead.get('address', '')} {lead.get('postcode', '')} Paris."
        + (f" Téléphone connu : {lead['phone']}." if lead.get("phone") else "")
        + "\nCherche ses coordonnées publiques avec la recherche Google, puis réponds exactement sur 4 lignes :\n"
        "SITE: <url de son propre site officiel, ou AUCUN> (Facebook, Instagram, Google, Planity, Treatwell, TheFork, "
        "Uber Eats, Deliveroo, Pages Jaunes, Tripadvisor et annuaires ne comptent PAS)\n"
        "TEL: <numéro publié, ou AUCUN>\nEMAIL: <email publié, ou AUCUN>\nINSTAGRAM: <url du compte, ou AUCUN>\n"
        "N'invente rien : si tu ne trouves pas une information dans une source, écris AUCUN."
    )
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
    body = {"contents": [{"parts": [{"text": prompt}]}], "tools": [{"google_search": {}}]}
    try:
        st, data = http_json("POST", url, body, timeout=60)
    except Exception as e:
        log("gemini lookup error", repr(e))
        return {}
    if st == 429:
        time.sleep(6)
        return {"_rate_limited": True}
    if st != 200:
        log("gemini lookup HTTP", st, str(data)[:160])
        return {}
    try:
        cand = data["candidates"][0]
        text = "".join(p.get("text", "") for p in cand["content"]["parts"])
    except (KeyError, IndexError, TypeError):
        return {}
    return accept_cited(parse_lookup(text), grounded_text(cand))


# ---------------- audit ----------------
def audit_site(url):
    html, final = fetch_page(url, timeout=12)
    a = {"url": final or url, "reachable": bool(html), "reasons": []}
    if not html:
        a["reasons"].append("le site ne répond pas")
        a["weak"] = True
        return a
    a["https"] = str(final).startswith("https://")
    a["viewport"] = bool(re.search(r'<meta[^>]+name=["\']viewport', html, re.I))
    years = [int(y) for y in re.findall(r"(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?((?:19|20)\d{2})", html, re.I)]
    a["year"] = max(years) if years else None
    a["phones"], a["emails"] = contacts_from_html(html)
    if not a["https"]:
        a["reasons"].append("pas de HTTPS : les navigateurs affichent « non sécurisé »")
    if not a["viewport"]:
        a["reasons"].append("le site n'est pas adapté au mobile")
    if a["year"] and a["year"] <= time.gmtime().tm_year - 4:
        a["reasons"].append(f"dernière mise à jour visible : {a['year']}")
    key = env("PAGESPEED_API_KEY")
    if key:
        q = urllib.parse.urlencode({"url": a["url"], "strategy": "mobile", "category": "performance", "key": key})
        try:
            st, data = http_json("GET", f"https://www.googleapis.com/pagespeedonline/v5/runPagespeed?{q}", timeout=90)
            if st == 200:
                a["score"] = round(data["lighthouseResult"]["categories"]["performance"]["score"] * 100)
                if a["score"] < 50:
                    a["reasons"].append(f"score mobile Google PageSpeed : {a['score']}/100")
        except Exception as e:
            log("pagespeed error", repr(e))
    a["weak"] = bool(a["reasons"])
    return a


# ---------------- qualify ----------------
class Budget:
    def __init__(self, n):
        self.n, self.lock = n, threading.Lock()

    def take(self):
        with self.lock:
            if self.n <= 0:
                return False
            self.n -= 1
            return True


def qualify(lead, budget):
    site = lead.get("website")
    if site and is_marketplace(site):
        site = lead["website"] = ""
    if not site:
        site = find_site_by_guess(lead) or ""
    # search enrichment: no site found yet, or no way to reach them
    if (not site or not (lead.get("phone") or lead.get("email"))) and budget.take():
        g = gemini_lookup(lead)
        for k in ("phone", "email", "instagram"):
            if g.get(k) and not lead.get(k):
                lead[k] = g[k]
                lead.setdefault("found_by_search", []).append(k)
        w = g.get("website")
        if not site and w:
            html, final = fetch_page(w)
            if html and (page_matches(html, lead) or not (lead.get("phone") or lead.get("address"))):
                site = final
            elif html:
                site = w  # loads but no hard match: assume it's theirs rather than pitch "you have no site"
    if not site:
        lead["kind"] = "no_site"
        return lead
    lead["website"] = site
    a = audit_site(site)
    lead["audit"] = a
    if not lead.get("phone") and a.get("phones"):
        lead["phone"] = fmt_phone(a["phones"][0])
    if not lead.get("email") and a.get("emails"):
        lead["email"] = a["emails"][0]  # published on their own site
    lead["kind"] = "weak_site" if a["weak"] else "skip"
    return lead


def qualify_all(leads, workers=8):
    budget = Budget(env_int("VERIFY_MAX", 80))
    with ThreadPoolExecutor(workers) as ex:
        return list(ex.map(lambda l: qualify(l, budget), leads))
