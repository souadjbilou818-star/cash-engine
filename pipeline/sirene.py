"""Lead source #2: the official French business registry (SIRENE via recherche-entreprises.api.gouv.fr).

Free, no key, official, complete. Its superpower: it knows which shops OPENED RECENTLY.
A business that opened 3 weeks ago has no site yet and is spending money on setup;
that's the hottest lead there is. OpenStreetMap usually doesn't list them yet.

Only storefront activities are pulled (the address is the shop, not someone's home).
Sole traders without a shop sign, non-diffusible entries and chains are skipped.
NAF codes are the rev.2 ones; INSEE switches to NAF 2025 in January 2027 (update the map then).
"""
import datetime as dt
import hashlib
import json
import re
import time
import urllib.parse

from common import DATA, env, env_int, http_json, log

API = "https://recherche-entreprises.api.gouv.fr/search"

# NAF code -> (cat_key, label, theme, weight)
NAF = {
    "56.10A": ("restaurant", "Restaurant", "food", 3),
    "56.10C": ("fast_food", "Restauration rapide", "food", 2),
    "56.30Z": ("bar", "Bar", "food", 2),
    "56.21Z": ("caterer", "Traiteur", "food", 3),
    "10.71C": ("bakery", "Boulangerie-pâtisserie", "food", 2),
    "10.71D": ("pastry", "Pâtisserie", "food", 2),
    "47.22Z": ("butcher", "Boucherie", "food", 2),
    "47.25Z": ("wine", "Cave à vin", "food", 2),
    "96.02A": ("hairdresser", "Salon de coiffure", "beauty", 3),
    "96.02B": ("beauty", "Institut de beauté", "beauty", 3),
    "47.76Z": ("florist", "Fleuriste", "retail", 3),
    "95.23Z": ("shoe_repair", "Cordonnerie", "craft", 2),
    "96.01B": ("dry_cleaning", "Pressing", "retail", 2),
    "45.20A": ("car_repair", "Garage automobile", "craft", 3),
}
DEFAULT_NAF = "56.10A,56.10C,56.21Z,10.71C,10.71D,96.02A,96.02B,47.76Z,95.23Z,96.01B,45.20A"
PARIS = [f"750{n:02d}" for n in range(1, 21)]

SMALL = {"de", "du", "des", "la", "le", "les", "l", "d", "et", "à", "a", "au", "aux", "en", "sur", "chez"}


def titlecase_fr(s):
    s = re.sub(r"\s+", " ", s or "").strip()
    if not s:
        return s
    if s != s.upper():
        return s  # already mixed case: keep the owner's spelling
    out = []
    for i, w in enumerate(s.lower().split(" ")):
        parts = re.split(r"([-'’])", w)
        parts = [p if p in ("-", "'", "’") or (i > 0 and p in SMALL) else p[:1].upper() + p[1:] for p in parts]
        out.append("".join(parts))
    return " ".join(out)


def _street(adresse, postcode):
    a = re.sub(r"\s+", " ", adresse or "").strip()
    a = re.split(rf"\s{postcode}\b", a)[0] if postcode else a
    return titlecase_fr(a)


def fetch(postcodes=None, naf_codes=None, days=None, max_pages=None, sleep=0.2):
    postcodes = postcodes or PARIS
    naf_codes = naf_codes or [c.strip() for c in env("SIRENE_NAF", DEFAULT_NAF).split(",") if c.strip()]
    days = days or env_int("SIRENE_DAYS", 180)
    max_pages = max_pages or env_int("SIRENE_MAX_PAGES", 40)
    cutoff = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    tag = hashlib.md5(f"{sorted(postcodes)}{sorted(naf_codes)}{days}{max_pages}".encode()).hexdigest()[:8]
    cache = DATA / f"sirene-{dt.date.today().isoformat()}-{tag}.json"
    if cache.exists():
        leads = json.loads(cache.read_text())
        log(f"sirene: using today's cache ({len(leads)} recently opened shops)")
        return leads
    leads, calls = [], 0
    for pc in postcodes:
        for naf in naf_codes:
            if naf not in NAF:
                log(f"sirene: unknown NAF {naf}, skipped")
                continue
            page = 1
            while page <= max_pages:
                q = urllib.parse.urlencode({
                    "activite_principale": naf, "code_postal": pc, "etat_administratif": "A",
                    "per_page": 25, "page": page, "limite_matching_etablissements": 10,
                })
                try:
                    st, data = http_json("GET", f"{API}?{q}", timeout=30)
                except Exception as e:
                    log("sirene: network", repr(e))
                    break
                calls += 1
                if st == 429:
                    time.sleep(5)
                    continue
                if st != 200 or not isinstance(data, dict):
                    log(f"sirene: HTTP {st} on {naf} {pc}")
                    break
                for r in data.get("results", []):
                    leads += parse_result(r, pc, naf, cutoff)
                if page >= int(data.get("total_pages") or 1):
                    break
                page += 1
                time.sleep(sleep)
    log(f"sirene: {calls} calls, {len(leads)} shops opened since {cutoff}")
    if calls:
        cache.write_text(json.dumps(leads))
    return leads


def parse_result(r, postcode, naf, cutoff):
    out = []
    if (r.get("nombre_etablissements_ouverts") or 1) > 3:
        return out  # a chain
    if str(r.get("statut_diffusion", "O")) != "O":
        return out  # the owner asked not to be listed
    is_sole_trader = str(r.get("nature_juridique", "")) == "1000"
    legal = r.get("nom_raison_sociale") or ""
    for m in r.get("matching_etablissements") or []:
        if m.get("etat_administratif") != "A" or m.get("code_postal") != postcode or m.get("activite_principale") != naf:
            continue
        opened = m.get("date_creation") or m.get("date_debut_activite") or ""
        if not opened or opened < cutoff:
            continue
        signs = [s for s in (m.get("liste_enseignes") or []) if s and "NON-DIFFUSIBLE" not in s.upper()]
        name = signs[0] if signs else ("" if is_sole_trader else legal)
        if not name or "NON-DIFFUSIBLE" in name.upper():
            continue
        cat_key, label, theme, weight = NAF[naf]
        try:
            lat, lon = float(m.get("latitude")), float(m.get("longitude"))
        except (TypeError, ValueError):
            lat = lon = None
        out.append({
            "osm_id": f"siret/{m.get('siret')}",
            "source": "sirene",
            "opened_on": opened,
            "name": titlecase_fr(name),
            "cat_key": cat_key, "category": label, "theme": theme, "weight": weight,
            "address": _street(m.get("adresse"), postcode),
            "postcode": postcode, "city": "Paris", "lat": lat, "lon": lon,
            "phone": "", "email": "", "instagram": "", "facebook": "", "website": "",
            "hours": "", "highlights": [], "cuisine": "",
        })
    return out
