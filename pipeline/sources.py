"""Lead source: OpenStreetMap via the Overpass API (free, no key, ODbL licensed).

Pulls independent local businesses that publish a phone or email.
Chains are dropped (brand tags) because they have corporate sites.
"""
import hashlib
import json
import time
import urllib.parse

from common import DATA, http, log

OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

# key: (osm filters, French label, theme, value weight 1-3)
# Health professions are left out on purpose: their advertising is regulated in France.
CATEGORIES = {
    "hairdresser":  ([("shop", "hairdresser")], "Salon de coiffure", "beauty", 3),
    "beauty":       ([("shop", "beauty")], "Institut de beauté", "beauty", 3),
    "restaurant":   ([("amenity", "restaurant")], "Restaurant", "food", 3),
    "cafe":         ([("amenity", "cafe")], "Café", "food", 2),
    "bakery":       ([("shop", "bakery")], "Boulangerie", "food", 2),
    "pastry":       ([("shop", "pastry")], "Pâtisserie", "food", 2),
    "butcher":      ([("shop", "butcher")], "Boucherie", "food", 2),
    "cheese":       ([("shop", "cheese")], "Fromagerie", "food", 2),
    "wine":         ([("shop", "wine")], "Cave à vin", "food", 2),
    "caterer":      ([("craft", "caterer")], "Traiteur", "food", 3),
    "florist":      ([("shop", "florist")], "Fleuriste", "retail", 3),
    "tailor":       ([("shop", "tailor"), ("craft", "tailor")], "Retouches & couture", "retail", 2),
    "shoe_repair":  ([("shop", "shoe_repair"), ("craft", "shoemaker")], "Cordonnerie", "craft", 2),
    "dry_cleaning": ([("shop", "dry_cleaning")], "Pressing", "retail", 2),
    "car_repair":   ([("shop", "car_repair")], "Garage automobile", "craft", 3),
    "bicycle":      ([("shop", "bicycle")], "Magasin & atelier vélo", "retail", 2),
    "tattoo":       ([("shop", "tattoo")], "Salon de tatouage", "dark", 3),
    "pet_grooming": ([("shop", "pet_grooming")], "Toilettage", "retail", 2),
    "plumber":      ([("craft", "plumber")], "Plombier", "craft", 3),
    "electrician":  ([("craft", "electrician")], "Électricien", "craft", 3),
}

DEFAULT_CATS = "hairdresser,beauty,restaurant,bakery,florist,tailor,shoe_repair,dry_cleaning,car_repair,tattoo,pet_grooming,caterer"

CUISINE_FR = {
    "french": "française", "italian": "italienne", "pizza": "pizzeria", "japanese": "japonaise", "sushi": "sushis",
    "chinese": "chinoise", "vietnamese": "vietnamienne", "thai": "thaïlandaise", "korean": "coréenne", "indian": "indienne",
    "lebanese": "libanaise", "moroccan": "marocaine", "greek": "grecque", "turkish": "turque", "spanish": "espagnole",
    "mexican": "mexicaine", "burger": "burgers", "crepe": "crêperie", "african": "africaine", "senegalese": "sénégalaise",
    "portuguese": "portugaise", "seafood": "poissons & fruits de mer", "regional": "régionale", "vegan": "vegan",
    "kebab": "kebab", "asian": "asiatique", "brazilian": "brésilienne", "peruvian": "péruvienne", "ethiopian": "éthiopienne",
}

MARKETPLACES = ("facebook.com", "instagram.com", "planity.com", "treatwell", "thefork", "lafourchette", "ubereats",
                "deliveroo", "pagesjaunes", "linktr.ee", "tripadvisor", "google.com", "goo.gl", "doctolib", "justeat",
                "wix.com/site-not-found", "business.site", "yelp")


def build_query(cat_keys, area_name="Paris", admin_level="8"):
    parts = []
    for k in cat_keys:
        for key, val in CATEGORIES[k][0]:
            parts.append(f'  nwr["{key}"="{val}"]["name"](area.a);')
    return (
        "[out:json][timeout:180];\n"
        f'area["name"="{area_name}"]["boundary"="administrative"]["admin_level"="{admin_level}"]->.a;\n'
        "(\n" + "\n".join(parts) + "\n);\nout center tags;"
    )


def fetch_overpass(cat_keys, area_name="Paris", admin_level="8", cache=True):
    day = time.strftime("%Y%m%d")
    tag = hashlib.md5(",".join(sorted(cat_keys)).encode()).hexdigest()[:8]
    cache_file = DATA / f"overpass-{area_name.lower()}-{day}-{tag}.json"
    if cache and cache_file.exists():
        log("overpass: using today's cache", cache_file.name)
        return json.loads(cache_file.read_text())["elements"]
    q = build_query(cat_keys, area_name, admin_level)
    last = None
    for url in OVERPASS_URLS:
        for attempt in range(2):
            try:
                log(f"overpass: querying {url} ({len(cat_keys)} categories)")
                st, body, _, _ = http("POST", url, "data=" + urllib.parse.quote(q),
                                      {"Content-Type": "application/x-www-form-urlencoded"}, timeout=240)
                if st == 200:
                    data = json.loads(body)
                    cache_file.write_text(json.dumps(data))
                    return data["elements"]
                last = f"HTTP {st}: {body[:200]!r}"
            except Exception as e:  # network, timeout, bad JSON
                last = repr(e)
            log("overpass: failed,", last)
            time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"Overpass unavailable: {last}")


def _first(tags, *keys):
    for k in keys:
        v = tags.get(k)
        if v:
            return v.split(";")[0].strip()
    return ""


def _social(v, base):
    v = (v or "").strip()
    if not v:
        return ""
    if v.startswith("http"):
        return v
    return base + v.lstrip("@")


def classify_cat(tags):
    for k, (filters, label, theme, weight) in CATEGORIES.items():
        for key, val in filters:
            if tags.get(key) == val:
                if k == "hairdresser" and (tags.get("hairdresser") in ("barber", "men") or "barb" in tags.get("name", "").lower()):
                    return "barber", "Barbier", "barber", 3
                if k == "beauty" and tags.get("beauty") == "nails":
                    return k, "Onglerie", theme, weight
                if k == "restaurant" and tags.get("cuisine"):
                    c = CUISINE_FR.get(tags["cuisine"].split(";")[0].strip())
                    if c:
                        return k, f"Restaurant · cuisine {c}" if c not in ("pizzeria", "burgers", "crêperie", "kebab", "sushis") else c.capitalize(), theme, weight
                return k, label, theme, weight
    return None


def highlights(tags, cat_key):
    h = []
    if tags.get("outdoor_seating") == "yes":
        h.append("Terrasse")
    if tags.get("takeaway") in ("yes", "only"):
        h.append("À emporter")
    if tags.get("delivery") == "yes":
        h.append("Livraison")
    if tags.get("diet:vegan") in ("yes", "only"):
        h.append("Options vegan")
    elif tags.get("diet:vegetarian") in ("yes", "only"):
        h.append("Options végétariennes")
    if tags.get("diet:halal") in ("yes", "only"):
        h.append("Halal")
    if tags.get("diet:gluten_free") in ("yes", "only"):
        h.append("Sans gluten")
    if tags.get("reservation") in ("yes", "recommended", "required"):
        h.append("Sur réservation" if tags["reservation"] == "required" else "Réservation conseillée")
    if tags.get("wheelchair") == "yes":
        h.append("Accessible PMR")
    if tags.get("internet_access") in ("wlan", "yes"):
        h.append("Wi-Fi")
    if cat_key in ("hairdresser", "barber") and tags.get("unisex") == "yes":
        h.append("Homme & femme")
    if tags.get("organic") in ("yes", "only"):
        h.append("Bio")
    return h


def normalize(el):
    tags = el.get("tags", {})
    name = tags.get("name", "").strip()
    if not name or tags.get("brand") or tags.get("brand:wikidata") or tags.get("disused") or tags.get("opening_hours") == "closed":
        return None
    cat = classify_cat(tags)
    if not cat:
        return None
    cat_key, label, theme, weight = cat
    phone = _first(tags, "phone", "contact:phone", "contact:mobile", "mobile")
    email = _first(tags, "email", "contact:email").lower()
    if not phone and not email:
        return None  # no way to reach them
    lat = el.get("lat") or (el.get("center") or {}).get("lat")
    lon = el.get("lon") or (el.get("center") or {}).get("lon")
    street = " ".join(x for x in (tags.get("addr:housenumber", ""), tags.get("addr:street", "")) if x).strip()
    website = _first(tags, "website", "contact:website", "url")
    return {
        "osm_id": f"{el['type']}/{el['id']}",
        "name": name,
        "cat_key": cat_key,
        "category": label,
        "theme": theme,
        "weight": weight,
        "address": street,
        "postcode": tags.get("addr:postcode", ""),
        "city": tags.get("addr:city", "Paris"),
        "lat": lat,
        "lon": lon,
        "phone": phone,
        "email": email,
        "instagram": _social(tags.get("contact:instagram"), "https://instagram.com/"),
        "facebook": _social(tags.get("contact:facebook"), "https://facebook.com/"),
        "website": website,
        "hours": tags.get("opening_hours", ""),
        "highlights": highlights(tags, cat_key),
        "cuisine": tags.get("cuisine", ""),
    }


def is_marketplace(url):
    u = (url or "").lower()
    return any(m in u for m in MARKETPLACES)
