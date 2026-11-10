"""Offline tests: JSON extraction, fact filter, provider fallback (fake OpenAI server), qualifiers."""
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import copywriter  # noqa: E402
import llm  # noqa: E402
import sources  # noqa: E402
import verify  # noqa: E402

ok = 0


def check(cond, label):
    global ok
    assert cond, label
    ok += 1
    print("✓", label)


# --- JSON extraction from messy model output
check(llm.extract_json('<think>hmm {"x":1}</think>Voici :\n```json\n{"a": "b {c}", "n": [1,2]}\n```') == {"a": "b {c}", "n": [1, 2]}, "extract_json strips think/fences, handles braces in strings")
check(llm.extract_json("no json here") is None, "extract_json returns None on garbage")

# --- invented facts are removed
s = copywriter._clean("Une coupe précise. Depuis 1998 à votre service. Noté 4,9 étoiles sur Google. À partir de 25 €.", 300)
check(s == "Une coupe précise.", f"fact filter keeps only safe sentences -> {s!r}")

# --- fallback across providers: first returns 429, second returns valid JSON
calls = []


class Fake(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers["Content-Length"])
        body = json.loads(self.rfile.read(n))
        calls.append((self.path, body["model"]))
        if self.path.startswith("/a/"):
            self.send_response(429); self.end_headers(); self.wfile.write(b'{"error":"rate"}')
            return
        content = '```json\n{"headline":"Le Liban, à la maison","subheadline":"Mezzés et grillades.","services_title":"À la carte","services":[{"title":"Mezzés","text":"Houmous, taboulé."},{"title":"Grillades","text":"Au charbon."},{"title":"À emporter","text":"Tout le menu."}],"about":"Une cuisine de famille. Ouvert depuis 2004.","seo_title":"Chez Nadia","seo_description":"Restaurant libanais Paris 11e"}\n```'
        out = json.dumps({"choices": [{"message": {"content": content}}]}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(out)

    def log_message(self, *a):
        pass


srv = HTTPServer(("127.0.0.1", 0), Fake)
threading.Thread(target=srv.serve_forever, daemon=True).start()
port = srv.server_address[1]
llm.PROVIDERS = {
    "first": {"base": f"http://127.0.0.1:{port}/a", "key": "K1", "model": ("M1", "model-a")},
    "second": {"base": f"http://127.0.0.1:{port}/b", "key": "K2", "model": ("M2", "model-b")},
}
os.environ.update({"K1": "x", "K2": "y", "LLM_PROVIDERS": "first,second"})
os.environ.pop("LLM_MOCK", None)
llm.time.sleep = lambda s: None
r = llm.Router()
lead = {"name": "Chez Nadia", "category": "Restaurant · cuisine libanaise", "cat_key": "restaurant", "postcode": "75011", "address": "12 Rue de la Roquette", "highlights": ["Terrasse"]}
site, src = copywriter.site_copy(r, lead)
check(src == "llm" and site["headline"] == "Le Liban, à la maison", "router falls back from 429 provider to the next one")
check(site["about"] == "Une cuisine de famille.", "invented 'depuis 2004' stripped from LLM output")
check(site["cta_label"] == "Réserver" and site["highlights"] == ["Terrasse"], "deterministic CTA + verified highlights")
check(any(p.startswith("/a/") for p, _ in calls) and any(p.startswith("/b/") for p, _ in calls), "both providers were tried")

# --- all providers dead -> fallback copy, never blocks
llm.PROVIDERS = {"dead": {"base": "http://127.0.0.1:9/x", "key": "K1", "model": ("M1", "m")}}
os.environ["LLM_PROVIDERS"] = "dead"
r2 = llm.Router()
for _ in range(4):
    site2, src2 = copywriter.site_copy(r2, lead)
check(src2 == "fallback" and site2["services"], "dead providers -> fallback copy, provider benched")

# --- qualifiers
check(verify.domain_guesses("Le Zinc") == [], "no risky domain guess for generic names")
check("boulangerie-martin.fr" in verify.domain_guesses("Boulangerie Martin"), "domain guesses built")
lead2 = {"phone": "01 43 00 11 22", "address": "5 Rue de Charonne", "postcode": "75011"}
check(verify.page_matches("<p>Tél : 01.43.00.11.22</p>", lead2), "page match by phone digits")
check(verify.page_matches("<p>5 rue de Charonne, 75011 Paris</p>", lead2), "page match by street + postcode")
check(not verify.page_matches("<p>Bienvenue</p>", lead2), "no match without a hard signal")
check(sources.is_marketplace("https://www.planity.com/salon-x"), "booking platforms don't count as a site")
el = {"type": "node", "id": 1, "lat": 1, "lon": 2, "tags": {"shop": "hairdresser", "name": "Kevin Barber Shop", "phone": "0612345678"}}
check(sources.normalize(el)["theme"] == "barber", "barbers detected from name")

# --- registry (SIRENE)
import sirene  # noqa: E402
check(sirene.titlecase_fr("LE COMPTOIR DE LÉA") == "Le Comptoir de Léa", "registry names title-cased the French way")
check(sirene.titlecase_fr("L'ATELIER D'ANNA") == "L'Atelier d'Anna", "apostrophes handled")
r = {"nature_juridique": "1000", "nombre_etablissements_ouverts": 1, "matching_etablissements": [
    {"siret": "1", "activite_principale": "96.02A", "code_postal": "75011", "etat_administratif": "A", "date_creation": "2026-10-01", "adresse": "1 RUE X 75011 PARIS", "liste_enseignes": None}]}
check(sirene.parse_result(r, "75011", "96.02A", "2026-01-01") == [], "sole trader without shop sign skipped (no personal names on demos)")
r["matching_etablissements"][0]["liste_enseignes"] = ["SALON ROSE"]
got = sirene.parse_result(r, "75011", "96.02A", "2026-01-01")
check(got and got[0]["name"] == "Salon Rose" and got[0]["address"] == "1 Rue X" and got[0]["opened_on"] == "2026-10-01", "shop sign used, address cleaned")
check(sirene.parse_result(r, "75011", "96.02A", "2026-11-01") == [], "older than the cutoff -> skipped")

# --- grounded search enrichment
txt = "SITE: AUCUN\nTEL: 01 43 55 66 77\nEMAIL: contact@salonrose.fr\nINSTAGRAM: https://instagram.com/salonrose"
found = verify.parse_lookup(txt)
check(found == {"phone": "01 43 55 66 77", "email": "contact@salonrose.fr", "instagram": "https://instagram.com/salonrose"}, "lookup answer parsed")
check(verify.accept_cited(found, "Le salon est joignable au 01.43.55.66.77 selon PagesJaunes.") == {"phone": "01 43 55 66 77", "instagram": "https://instagram.com/salonrose"},
      "phone kept (cited), email dropped (not in a cited passage)")
check(verify.accept_cited(found, "") == {"instagram": "https://instagram.com/salonrose"}, "nothing cited -> no phone/email (no hallucinated contacts)")
ph, em = verify.contacts_from_html('<a href="tel:+33143556677">Appeler</a> <a href="mailto:bonjour@salonrose.fr?subject=hi">x</a> <img src="logo@2x.png">')
check(ph == ["0143556677"] and em == ["bonjour@salonrose.fr"], "contacts pulled from their own site")

# --- outreach sequence
os.environ.update({"AGENCY_PERSON": "Sami", "AGENCY_NAME": "Studio Rive"})
o = copywriter.outreach({"name": "Salon Rose", "kind": "no_site", "postcode": "75011", "category": "Salon de coiffure", "opened_on": "2026-10-01"})
check(all(k in o for k in ("email_body", "email_bump", "email_opened", "email_last", "walkin")), "full sequence + walk-in script generated")
check("félicitations" in o["email_body"] and all("{stop}" in o[k] for k in ("email_body", "email_bump", "email_opened", "email_last")), "new-business hook + opt-out in every email")

print(f"\n{ok} checks passed")
