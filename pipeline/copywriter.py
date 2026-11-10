"""Site copy (LLM, guarded) + outreach copy (templates, deterministic).

The LLM writes the demo site. It is forbidden to invent facts, and a filter removes
any sentence that slipped one in (prices, years, ratings, reviews, awards).
Outreach messages are templates on purpose: predictable, short, legal footer every time.
Placeholders {url} {stop} {expiry} are filled by the Worker / sender at send time.
"""
import re

from common import env

CTA = {
    "restaurant": "Réserver", "cafe": "Appeler", "caterer": "Demander un devis",
    "hairdresser": "Prendre rendez-vous", "barber": "Prendre rendez-vous", "beauty": "Prendre rendez-vous",
    "tattoo": "Prendre rendez-vous", "pet_grooming": "Prendre rendez-vous",
    "plumber": "Demander un devis", "electrician": "Demander un devis", "car_repair": "Demander un devis",
}

SYSTEM = (
    "Tu écris les textes du site vitrine d'un commerce indépendant parisien. "
    "Style : sobre, chaleureux, concret, phrases courtes, vocabulaire du métier, aucun superlatif creux, aucun emoji. "
    "INTERDIT d'inventer des faits : pas de prix, d'années, d'ancienneté, de récompenses, de labels, d'avis ou de notes clients, "
    "de noms de personnes, de produits ou spécialités qui ne sont pas dans les données. "
    "Si une information manque, reste générique pour ce type de commerce. "
    "Ne répète pas le nom du commerce dans le titre principal. Réponds uniquement avec un objet JSON valide."
)

SCHEMA = """{
  "headline": "accroche, 3 à 8 mots",
  "subheadline": "1 phrase, 22 mots max",
  "services_title": "titre de section, 6 mots max",
  "services": [{"title": "5 mots max", "text": "22 mots max"}, {"title": "", "text": ""}, {"title": "", "text": ""}],
  "about": "2 phrases, 45 mots max",
  "seo_title": "60 caractères max",
  "seo_description": "155 caractères max"
}"""

BANNED = re.compile(
    r"(€|\beuros?\b|\d+\s?%|\bdepuis\s+(?:19|20)\d{2}|\b\d+\s+ans\b|étoiles?|\bavis\b|\bnoté|\bprim[ée]|\brécompens|"
    r"\blabel|meilleur(?:e|s)?\s+(?:de|du)\s+paris|\bn°\s?1\b|guide michelin|gault|\btripadvisor)",
    re.I,
)


def _clean(s, limit):
    s = re.sub(r"\s+", " ", str(s or "")).strip().strip('"')
    parts = re.split(r"(?<=[.!?])\s+", s)
    s = " ".join(p for p in parts if not BANNED.search(p))
    if len(s) > limit:
        s = s[:limit].rsplit(" ", 1)[0].rstrip(",;:") + "…"
    return s


def arr_label(postcode):
    m = re.match(r"^750(\d{2})$", postcode or "")
    if not m:
        return ""
    n = int(m.group(1))
    return "1er" if n == 1 else f"{n}e"


def user_prompt(lead):
    arr = arr_label(lead.get("postcode"))
    facts = [
        f"Nom : {lead['name']}",
        f"Type : {lead['category']}",
        f"Quartier : Paris {arr}" if arr else "Ville : Paris",
        f"Adresse : {lead.get('address','')}".strip(),
    ]
    if lead.get("cuisine"):
        facts.append(f"Cuisine (tag OpenStreetMap) : {lead['cuisine']}")
    if lead.get("highlights"):
        facts.append("Atouts confirmés : " + ", ".join(lead["highlights"]))
    if lead.get("hours"):
        facts.append("Horaires publiés : oui")
    return "Données (les seules vérifiées) :\n" + "\n".join(facts) + "\n\nRemplis ce JSON en français :\n" + SCHEMA


def fallback_site(lead):
    arr = arr_label(lead.get("postcode"))
    where = f"Paris {arr}" if arr else "Paris"
    cat = lead["category"].split(" · ")[0]
    return {
        "headline": "Votre adresse de quartier",
        "subheadline": f"{cat} à {where}. Passez nous voir ou appelez-nous, on vous répond avec plaisir.",
        "services_title": "Ce que nous faisons",
        "services": [
            {"title": "Accueil et conseil", "text": "On prend le temps de comprendre ce dont vous avez besoin."},
            {"title": "Travail soigné", "text": "Un savoir-faire de métier, appliqué à chaque demande."},
            {"title": "Tout près de chez vous", "text": f"Une adresse simple d'accès, au cœur du {arr or 'quartier'}."},
        ],
        "about": f"{lead['name']} est un commerce indépendant de {where}. Une équipe de proximité, joignable directement par téléphone.",
        "seo_title": f"{lead['name']} · {cat} · {where}"[:60],
        "seo_description": f"{lead['name']}, {cat.lower()} à {where} : horaires, adresse et téléphone."[:155],
    }


def site_copy(router, lead):
    raw = router.json(SYSTEM, user_prompt(lead)) if router.available() else None
    base = fallback_site(lead)
    if not isinstance(raw, dict):
        site, source = base, "fallback"
    else:
        site, source = {}, "llm"
        for k, lim in (("headline", 70), ("subheadline", 180), ("services_title", 50), ("about", 330), ("seo_title", 60), ("seo_description", 155)):
            site[k] = _clean(raw.get(k), lim) or base[k]
        svc = []
        for s in (raw.get("services") or [])[:4]:
            if isinstance(s, dict):
                t, x = _clean(s.get("title"), 48), _clean(s.get("text"), 170)
                if t and x:
                    svc.append({"title": t, "text": x})
        site["services"] = svc if len(svc) >= 3 else base["services"]
    site["cta_label"] = CTA.get(lead["cat_key"], "Appeler")
    site["highlights"] = lead.get("highlights", [])
    return site, source


MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"]


def de(name):
    """French contraction: de + Le Comptoir -> du Comptoir, de + Ongles d'Or -> d'Ongles d'Or."""
    if name.startswith("Le "):
        return "du " + name[3:]
    if name.startswith("Les "):
        return "des " + name[4:]
    if re.match(r"^[AEIOUYÉÈÊÂÎÔaeiouyéèêâîô]", name):
        return "d'" + name
    return "de " + name


def opened_phrase(opened_on):
    """'2026-09-14' -> 'en septembre' (or 'en septembre 2025' if not this year); '' if older than a year."""
    import datetime as dt
    try:
        d = dt.date.fromisoformat(opened_on)
    except (TypeError, ValueError):
        return ""
    today = dt.date.today()
    if (today - d).days > 365:
        return ""
    return f"en {MONTHS[d.month - 1]}" + (f" {d.year}" if d.year != today.year else "")


def outreach(lead):
    person = env("AGENCY_PERSON", "Prénom")
    agency = env("AGENCY_NAME", "Studio")
    phone = env("AGENCY_PHONE", "")
    price, monthly, delay = env("OFFER_PRICE", "390 €"), env("OFFER_MONTHLY", "19 €/mois"), env("OFFER_DELAY", "48 h")
    arr = arr_label(lead.get("postcode"))
    quartier = f"du {arr}" if arr else "du quartier"
    name = lead["name"]
    de_name = de(name)
    reasons = (lead.get("audit") or {}).get("reasons") or []
    opened = opened_phrase(lead.get("opened_on"))
    footer = (f"—\nVous recevez ce message car cette adresse est publiée comme contact professionnel {de_name}. "
              f"Pour ne plus être contacté : {{stop}}")

    if lead["kind"] == "weak_site":
        domain = re.sub(r"^https?://(www\.)?", "", (lead.get("audit") or {}).get("url") or lead.get("website") or "").split("/")[0]
        subject = f"{name} : une nouvelle version de votre site"
        problem = f"J'ai regardé {domain} : {reasons[0]}." if reasons else f"J'ai regardé {domain}."
        intro = f"{problem} J'ai préparé une version neuve, avec vos horaires et votre adresse :"
        hook = f"j'ai refait une version de votre site ({reasons[0]} sur l'actuel)" if reasons else "j'ai refait une version de votre site"
        call = (f"« Bonjour, {person}, je fais des sites pour les commerces {quartier}. J'ai regardé votre site"
                f"{' : ' + reasons[0] if reasons else ''}. J'ai préparé une nouvelle version pour {name}, "
                f"je vous l'envoie par SMS pour comparer ? Ça prend 30 secondes. »")
    elif opened:
        subject = f"{name} : le site de votre ouverture"
        intro = (f"J'ai vu que {name} a ouvert {opened}, félicitations ! Pour vous faire gagner du temps, "
                 f"j'ai préparé une maquette de votre site, avec votre adresse et votre plan :")
        hook = f"félicitations pour l'ouverture {de_name} ! J'ai préparé une maquette de votre site"
        call = (f"« Bonjour, {person}, je fais des sites pour les commerces {quartier}. Félicitations pour l'ouverture ! "
                f"J'ai préparé une maquette de site pour {name}, je vous l'envoie par SMS ? Ça prend 30 secondes. »")
    else:
        subject = f"{name} : j'ai fait une maquette de votre site"
        intro = (f"En regardant les commerces {quartier} en ligne, j'ai vu que {name} n'avait pas de site. "
                 f"J'en ai fait une maquette, avec vos horaires et votre adresse :")
        hook = f"j'ai fait une maquette de site pour {name}"
        call = (f"« Bonjour, {person}, je fais des sites pour les commerces {quartier}. J'ai préparé une maquette pour {name}, "
                f"je vous l'envoie par SMS pour que vous jetiez un œil ? Ça prend 30 secondes. »")

    email = (
        f"Bonjour,\n\nJe suis {person}, je fais des sites pour les commerces {quartier}.\n{intro}\n\n{{url}}\n\n"
        f"Elle reste en ligne jusqu'au {{expiry}}. Si elle vous plaît, je la mets en ligne sur votre propre adresse "
        f"en {delay} ({price}, puis {monthly} pour l'hébergement et les modifications, sans engagement).\n"
        f"Sinon, aucun souci : elle disparaît d'elle-même.\n\n{person}\n{agency} · {phone}\n\n{footer}"
    )
    bump = (
        f"Bonjour,\n\nJe me permets de vous relancer : la maquette {de_name} est toujours en ligne ici :\n{{url}}\n\n"
        f"Une réponse en un mot me suffit : « oui », « non » ou « plus tard ».\n\n{person} · {phone}\n\n{footer}"
    )
    nudge = (
        f"Bonjour,\n\nAvez-vous eu le temps de regarder la maquette {de_name} ? Si un détail ne vous plaît pas "
        f"(couleurs, textes, photos), je l'adapte avant la mise en ligne, sans frais.\n\n{{url}}\n\n{person} · {phone}\n\n{footer}"
    )
    last = (
        f"Bonjour,\n\nDernier message de ma part : la maquette {de_name} sera supprimée le {{expiry}}. "
        f"Si vous la voulez, répondez simplement « oui » et je m'occupe du reste.\n\n{{url}}\n\n{person}\n\n{footer}"
    )
    sms = (
        f"Bonjour, ici {person} ({agency}). {hook[0].upper() + hook[1:]}, gratuite et sans engagement : {{url}} "
        f"Elle reste en ligne jusqu'au {{expiry}}. Si ça vous parle, répondez-moi ici. STOP pour ne plus être contacté."
    )
    walkin = (f"« Bonjour, {person}, je fais des sites pour les commerces du quartier. J'ai préparé celui {de_name}, "
              f"je peux vous le montrer ? 30 secondes. » Puis montrez la démo sur votre téléphone.")
    return {"email_subject": subject, "email_body": email, "email_bump": bump, "email_opened": nudge, "email_last": last,
            "sms": sms, "call_opener": call, "walkin": walkin}
