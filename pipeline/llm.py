"""Free-tier LLM router with fallback.

Every provider below speaks the OpenAI chat-completions format. When one rate-limits
or fails, the next one takes over; a provider that fails 3 times in a row is benched
for the rest of the run. Order is set by LLM_PROVIDERS in .env.
"""
import json
import re
import time

from common import env, http_json, log

PROVIDERS = {
    "gemini": {
        "base": "https://generativelanguage.googleapis.com/v1beta/openai",
        "key": "GEMINI_API_KEY", "model": ("GEMINI_MODEL", "gemini-2.5-flash"),
    },
    "nim": {
        "base": "https://integrate.api.nvidia.com/v1",
        "key": "NVIDIA_API_KEY", "model": ("NIM_MODEL", "google/gemma-4-31b-it"),
    },
    "cloudflare": {
        "base": "https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/ai/v1",
        "key": "CF_API_TOKEN", "model": ("CF_MODEL", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
    },
    "groq": {
        "base": "https://api.groq.com/openai/v1",
        "key": "GROQ_API_KEY", "model": ("GROQ_MODEL", "openai/gpt-oss-120b"),
    },
    "openrouter": {
        "base": "https://openrouter.ai/api/v1",
        "key": "OPENROUTER_API_KEY", "model": ("OPENROUTER_MODEL", "openrouter/free"),
    },
}


class Router:
    def __init__(self, order=None):
        names = [n.strip() for n in (order or env("LLM_PROVIDERS", "gemini,nim,cloudflare,groq,openrouter")).split(",") if n.strip()]
        self.active = []
        for n in names:
            p = PROVIDERS.get(n)
            if not p or not env(p["key"]):
                continue
            base = p["base"].replace("{CF_ACCOUNT_ID}", env("CF_ACCOUNT_ID"))
            if "{" in base or (n == "cloudflare" and not env("CF_ACCOUNT_ID")):
                continue
            self.active.append({"name": n, "base": base, "key": env(p["key"]), "model": env(*p["model"]), "fails": 0})
        self.mock = env("LLM_MOCK") == "1"
        self.calls = {}
        if not self.active and not self.mock:
            log("llm: no provider key set -> using built-in fallback copy (still works, less personal)")

    def available(self):
        return self.mock or any(p["fails"] < 3 for p in self.active)

    def json(self, system, user, max_tokens=1400):
        """Returns a parsed JSON object or None."""
        if self.mock:
            return mock_answer(user)
        for p in self.active:
            if p["fails"] >= 3:
                continue
            for attempt in range(2):
                out = self._call(p, system, user, max_tokens)
                if out is not None:
                    p["fails"] = 0
                    self.calls[p["name"]] = self.calls.get(p["name"], 0) + 1
                    return out
                p["fails"] += 1
                if p["fails"] >= 3:
                    log(f"llm: benching {p['name']} for this run")
                    break
        return None

    def _call(self, p, system, user, max_tokens):
        body = {
            "model": p["model"],
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "temperature": 0.6,
            "max_tokens": max_tokens,
        }
        try:
            st, data = http_json("POST", p["base"] + "/chat/completions", body,
                                 {"Authorization": f"Bearer {p['key']}"}, timeout=90)
        except Exception as e:
            log(f"llm {p['name']}: network {e!r}")
            return None
        if st == 429:
            log(f"llm {p['name']}: rate limited")
            time.sleep(4)
            return None
        if st != 200:
            log(f"llm {p['name']}: HTTP {st} {str(data)[:160]}")
            return None
        try:
            text = data["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError):
            return None
        return extract_json(text)


def extract_json(text):
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)  # reasoning models
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    start = text.find("{")
    if start < 0:
        return None
    depth, in_str, esc = 0, False, False
    for i, ch in enumerate(text[start:], start):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:i + 1])
                except ValueError:
                    return None
    return None


def mock_answer(user):
    m = re.search(r"Nom : (.+)", user)
    name = m.group(1).strip() if m else "Commerce"
    return {
        "headline": "Le savoir-faire du quartier, à deux pas",
        "subheadline": f"{name} vous accueille avec simplicité et le souci du travail bien fait.",
        "services_title": "Ce que nous faisons",
        "services": [
            {"title": "Accueil sans chichis", "text": "On prend le temps de vous écouter et de vous conseiller."},
            {"title": "Travail soigné", "text": "Chaque détail compte, du premier au dernier geste."},
            {"title": "Au cœur du quartier", "text": "Une adresse de proximité, facile d'accès."},
        ],
        "about": f"{name} est une adresse de quartier. Passez nous voir ou appelez-nous, on vous répond avec plaisir.",
        "seo_title": f"{name} · Paris",
        "seo_description": f"{name} à Paris : horaires, adresse, téléphone.",
    }
