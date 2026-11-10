// HTML rendering: demo sites, live client sites, admin hit list.
// Everything coming from the DB or the LLM is escaped with esc().

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function checkoutUrl(env, slug) {
  const u = String(env.CHECKOUT_URL || "");
  if (!/^https?:\/\//.test(u)) return "";
  return u + (u.includes("?") ? "&" : "?") + "client_reference_id=" + encodeURIComponent(slug);
}

const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? String(u) : "");

const THEMES = {
  food:   { bg: "#F5EFE6", surface: "#FFFDF9", ink: "#1F1A15", muted: "#6B5E52", line: "#E4D9CB", accent: "#B4532A", accentInk: "#FFFFFF", a2: "#E2A54B", display: "Fraunces", dark: false },
  beauty: { bg: "#F6EEEA", surface: "#FFFBF9", ink: "#231B1C", muted: "#75625F", line: "#EADBD5", accent: "#9A5466", accentInk: "#FFFFFF", a2: "#D9A79A", display: "Fraunces", dark: false },
  retail: { bg: "#EEF1EB", surface: "#FBFCFA", ink: "#18201B", muted: "#5D6B61", line: "#D9E0D6", accent: "#2F6A4E", accentInk: "#FFFFFF", a2: "#A9C49A", display: "Fraunces", dark: false },
  barber: { bg: "#111110", surface: "#1B1B19", ink: "#F2EDE4", muted: "#A39E94", line: "#2C2B28", accent: "#C9A35E", accentInk: "#111110", a2: "#7A5B2E", display: "Bricolage Grotesque", dark: true },
  craft:  { bg: "#0E1726", surface: "#152237", ink: "#F4F6FA", muted: "#9AA7BC", line: "#22324D", accent: "#F3B21B", accentInk: "#0E1726", a2: "#3B5B8C", display: "Bricolage Grotesque", dark: true },
  dark:   { bg: "#0B0B0C", surface: "#161618", ink: "#EDEDED", muted: "#9A9AA0", line: "#26262A", accent: "#E0533D", accentInk: "#FFFFFF", a2: "#5B2A22", display: "Bricolage Grotesque", dark: true },
};

// ---------- opening hours (OSM syntax, common forms) ----------
const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const DAY_FR = { Mo: "Lundi", Tu: "Mardi", We: "Mercredi", Th: "Jeudi", Fr: "Vendredi", Sa: "Samedi", Su: "Dimanche" };

export function parseHours(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s === "24/7") return Object.fromEntries(DAYS.map((d) => [d, "Ouvert 24h/24"]));
  const out = {};
  for (const partRaw of s.split(";")) {
    const part = partRaw.trim();
    if (!part || /^PH\b/.test(part)) continue;
    const m = part.match(/^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:\s*,\s*(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)\s+(.+)$/);
    let days, times;
    if (m) { days = m[1]; times = m[2]; }
    else if (/^\d{1,2}:\d{2}/.test(part)) { days = "Mo-Su"; times = part; }
    else return null; // unknown syntax: don't guess
    const list = [];
    for (const chunk of days.split(",")) {
      const [a, b] = chunk.split("-").map((x) => x.trim());
      const ia = DAYS.indexOf(a), ib = b ? DAYS.indexOf(b) : ia;
      if (ia < 0 || ib < 0) return null;
      for (let i = ia; ; i = (i + 1) % 7) { list.push(DAYS[i]); if (i === ib) break; }
    }
    const label = /off|closed/i.test(times)
      ? "Fermé"
      : times.split(",").map((t) => t.trim().replace(/(\d{1,2}):(\d{2})/g, (_, h, mm) => `${+h}h${mm === "00" ? "" : mm}`).replace("-", "–")).join(" · ");
    for (const d of list) out[d] = label;
  }
  if (!Object.keys(out).length) return null;
  for (const d of DAYS) if (!out[d]) out[d] = "Fermé";
  return out;
}

function todayKey(now = new Date()) {
  const wd = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "Europe/Paris" }).format(now); // Mon, Tue...
  return { Mon: "Mo", Tue: "Tu", Wed: "We", Thu: "Th", Fri: "Fr", Sat: "Sa", Sun: "Su" }[wd];
}

export const frDate = (ts) =>
  new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", timeZone: "Europe/Paris" }).format(new Date(ts));

export function arrondissement(postcode) {
  const m = String(postcode || "").match(/^750(\d{2})$/);
  if (!m) return "";
  const n = parseInt(m[1], 10);
  return n === 1 ? "1er" : `${n}e`;
}

const telHref = (p) => "tel:" + String(p || "").replace(/[^\d+]/g, "");

// "+33 6 12 34 56 78" / "0612345678" -> "06 12 34 56 78" (how French owners read their number)
export function frPhone(p) {
  let d = String(p || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+33")) d = "0" + d.slice(3);
  else if (d.startsWith("0033")) d = "0" + d.slice(4);
  return /^0\d{9}$/.test(d) ? d.replace(/(\d{2})(?=\d)/g, "$1 ") : String(p || "");
}

// ---------- the client site (demo or live) ----------
export function renderSite(lead, env, mode /* demo | preview | live */) {
  const t = THEMES[lead.theme] || THEMES.retail;
  const c = safeJson(lead.content);
  const site = c.site || {};
  const name = lead.name;
  const arr = arrondissement(lead.postcode);
  const where = arr ? `Paris ${arr}` : lead.city || "Paris";
  const hours = parseHours(lead.hours);
  const tk = todayKey();
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name} ${lead.address || ""} ${lead.postcode || ""} Paris`)}`;
  const bbox = lead.lat && lead.lon ? [lead.lon - 0.004, lead.lat - 0.0025, lead.lon + 0.004, lead.lat + 0.0025].map((x) => x.toFixed(5)).join(",") : "";
  const services = Array.isArray(site.services) ? site.services.slice(0, 4) : [];
  const highlights = Array.isArray(site.highlights) ? site.highlights.slice(0, 6) : [];
  const initial = (name.match(/[A-Za-zÀ-ÿ0-9]/) || ["•"])[0].toUpperCase();
  const demo = mode !== "live";
  const fontQ = t.display === "Fraunces" ? "Fraunces:opsz,wght@9..144,500;9..144,700" : "Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800";
  const expires = lead.expires_at ? frDate(lead.expires_at) : "";
  const ig = safeUrl(lead.instagram);

  return `<!doctype html><html lang="fr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(site.seo_title || `${name} · ${lead.category || ""} · ${where}`)}</title>
<meta name="description" content="${esc(site.seo_description || site.subheadline || "")}">
${demo ? '<meta name="robots" content="noindex,nofollow,noarchive">' : ""}
<meta name="theme-color" content="${t.bg}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=${fontQ}&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--bg:${t.bg};--surface:${t.surface};--ink:${t.ink};--muted:${t.muted};--line:${t.line};--accent:${t.accent};--accent-ink:${t.accentInk};--a2:${t.a2};--display:"${t.display}",Georgia,serif}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--ink);font:400 17px/1.6 Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased;${demo ? "padding-top:44px;" : ""}padding-bottom:84px}
a{color:inherit}
.wrap{max-width:1120px;margin:0 auto;padding:0 22px}
.demo-bar{position:fixed;inset:0 0 auto 0;height:44px;z-index:50;display:flex;align-items:center;justify-content:center;gap:12px;background:#111;color:#f5f5f5;font-size:13px;padding:0 12px}
.demo-bar b{font-weight:600}.demo-bar .muted{opacity:.7}
.demo-bar a{background:#fff;color:#111;text-decoration:none;font-weight:600;padding:6px 12px;border-radius:99px;white-space:nowrap}
@media(max-width:640px){.demo-bar .hide-sm{display:none}}
header.top{display:flex;align-items:center;justify-content:space-between;padding:20px 0}
.logo{font:700 22px/1 var(--display);letter-spacing:-.01em;text-decoration:none}
.btn{display:inline-flex;align-items:center;gap:8px;border-radius:99px;padding:14px 22px;font-weight:600;font-size:16px;text-decoration:none;border:1.5px solid transparent;cursor:pointer}
.btn-primary{background:var(--accent);color:var(--accent-ink)}
.btn-ghost{border-color:var(--line);background:var(--surface)}
.btn-sm{padding:9px 16px;font-size:14px}
.hero{display:grid;grid-template-columns:1.15fr .85fr;gap:48px;align-items:center;padding:40px 0 72px}
.eyebrow{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:600}
h1{font:700 clamp(44px,7vw,84px)/.98 var(--display);letter-spacing:-.025em;margin:16px 0 18px}
.lead{font-size:clamp(18px,2.1vw,21px);color:var(--muted);max-width:34ch}
.cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:30px}
.today{display:inline-flex;align-items:center;gap:8px;margin-top:22px;font-size:14px;color:var(--muted)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--accent)}
.art{position:relative;aspect-ratio:4/5;max-width:420px;justify-self:end;width:100%}
.arch{position:absolute;inset:0;border-radius:999px 999px 28px 28px;background:
 radial-gradient(120% 80% at 20% 10%,var(--a2) 0%,transparent 60%),
 radial-gradient(90% 70% at 90% 90%,var(--accent) 0%,transparent 65%),var(--surface);
 box-shadow:inset 0 0 0 1px var(--line);overflow:hidden}
.arch::after{content:"";position:absolute;inset:14px;border-radius:999px 999px 18px 18px;border:1px solid ${t.dark ? "rgba(255,255,255,.18)" : "rgba(0,0,0,.10)"}}
.arch span{position:absolute;inset:0;display:grid;place-items:center;font:700 min(46vw,240px)/1 var(--display);color:${t.dark ? "rgba(255,255,255,.92)" : "rgba(255,255,255,.95)"};text-shadow:0 10px 40px rgba(0,0,0,.18)}
.grain{position:absolute;inset:0;opacity:.18;mix-blend-mode:overlay;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence baseFrequency='.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
.chips{display:flex;flex-wrap:wrap;gap:10px;padding:0 0 56px}
.chip{border:1px solid var(--line);background:var(--surface);border-radius:99px;padding:8px 14px;font-size:14px;font-weight:500}
section{padding:72px 0;border-top:1px solid var(--line)}
h2{font:700 clamp(30px,4vw,44px)/1.05 var(--display);letter-spacing:-.02em;margin-bottom:34px;max-width:20ch}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:18px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:22px;padding:26px}
.card .n{font:700 14px/1 Inter;color:var(--accent);letter-spacing:.1em}
.card h3{font:600 20px/1.25 var(--display);margin:14px 0 8px}
.card p{color:var(--muted);font-size:15.5px}
.about{font:500 clamp(22px,3vw,32px)/1.35 var(--display);letter-spacing:-.01em;max-width:30ch}
.info{display:grid;grid-template-columns:1fr 1fr;gap:28px}
.hours{width:100%;border-collapse:collapse}
.hours td{padding:11px 0;border-bottom:1px solid var(--line);font-size:16px}
.hours td:last-child{text-align:right;color:var(--muted)}
.hours tr.is-today td{font-weight:600;color:var(--ink)}
.map{width:100%;height:100%;min-height:300px;border:0;border-radius:22px;filter:${t.dark ? "invert(.9) hue-rotate(180deg) contrast(.9)" : "saturate(.6)"}}
.addr{margin-top:22px;font-size:16px}
footer{padding:44px 0;color:var(--muted);font-size:14px;border-top:1px solid var(--line)}
.sticky{position:fixed;left:12px;right:12px;bottom:12px;z-index:40;display:none;gap:10px}
.sticky .btn{flex:1;justify-content:center}
.claim{display:none;position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.55);align-items:flex-end;justify-content:center}
.claim:target,.claim.open{display:flex}
.sheet{background:#fff;color:#151515;width:100%;max-width:520px;border-radius:26px 26px 0 0;padding:28px 24px 30px;max-height:92vh;overflow:auto;font-family:Inter,system-ui,sans-serif}
@media(min-width:700px){.claim{align-items:center}.sheet{border-radius:26px}}
.sheet h3{font:700 26px/1.15 Inter;letter-spacing:-.02em;margin-bottom:6px}
.price{display:flex;align-items:baseline;gap:10px;margin:18px 0 6px}
.price b{font-size:36px;letter-spacing:-.02em}.price span{color:#666}
.sheet ul{list-style:none;margin:14px 0 20px}.sheet li{padding:7px 0;border-bottom:1px solid #eee;font-size:15px}
.sheet li::before{content:"✓  ";color:#1a7f4b;font-weight:700}
.sheet input,.sheet textarea{width:100%;font:inherit;font-size:16px;padding:13px 14px;border:1px solid #ddd;border-radius:12px;margin-bottom:10px}
.sheet button{width:100%;background:#111;color:#fff;border:0;border-radius:99px;padding:15px;font:600 16px Inter;cursor:pointer}
.sheet .x{float:right;text-decoration:none;color:#999;font-size:22px;line-height:1}
.sheet .alt{display:block;text-align:center;margin-top:12px;font-weight:600}
@media(max-width:860px){.hero{grid-template-columns:1fr;gap:28px;padding-top:12px}.art{max-width:none;aspect-ratio:16/11;justify-self:stretch;order:-1}.arch{border-radius:28px}.arch::after{border-radius:18px}.arch span{font-size:min(38vw,200px)}.info{grid-template-columns:1fr}.sticky{display:flex}header.top .btn{display:none}}
</style></head><body>
${demo ? `<div class="demo-bar"><span><b>Maquette pour ${esc(name)}</b> <span class="muted hide-sm">· non officielle${expires ? ` · expire le ${esc(expires)}` : ""}</span></span><a href="#claim" data-ev="cta_claim">Je la veux →</a></div>` : ""}
<div class="wrap">
<header class="top"><a class="logo" href="#">${esc(name)}</a>${lead.phone ? `<a class="btn btn-primary btn-sm" href="${esc(telHref(lead.phone))}" data-ev="cta_call">Appeler</a>` : ""}</header>
<div class="hero">
  <div>
    <div class="eyebrow">${esc(lead.category || "")} · ${esc(where)}</div>
    <h1>${esc(site.headline || name)}</h1>
    <p class="lead">${esc(site.subheadline || "")}</p>
    <div class="cta">
      ${lead.phone ? `<a class="btn btn-primary" href="${esc(telHref(lead.phone))}" data-ev="cta_call">${esc(site.cta_label || "Appeler")} · ${esc(frPhone(lead.phone))}</a>` : ""}
      <a class="btn btn-ghost" href="${esc(mapsUrl)}" target="_blank" rel="noopener">Itinéraire</a>
    </div>
    ${hours && hours[tk] ? `<div class="today"><span class="dot"></span>Aujourd'hui : ${esc(hours[tk])}</div>` : ""}
  </div>
  <div class="art"><div class="arch"><div class="grain"></div><span>${esc(initial)}</span></div></div>
</div>
${highlights.length ? `<div class="chips">${highlights.map((h) => `<span class="chip">${esc(h)}</span>`).join("")}</div>` : ""}
</div>
${services.length ? `<section><div class="wrap"><h2>${esc(site.services_title || "Ce que nous faisons")}</h2><div class="grid">${services
    .map((s, i) => `<div class="card"><div class="n">0${i + 1}</div><h3>${esc(s.title)}</h3><p>${esc(s.text)}</p></div>`)
    .join("")}</div></div></section>` : ""}
${site.about ? `<section><div class="wrap"><div class="eyebrow" style="margin-bottom:18px">${esc(name)}</div><p class="about">${esc(site.about)}</p></div></section>` : ""}
<section id="infos"><div class="wrap"><h2>Nous trouver</h2><div class="info">
  <div>
    ${hours ? `<table class="hours">${DAYS.map((d) => `<tr class="${d === tk ? "is-today" : ""}"><td>${DAY_FR[d]}</td><td>${esc(hours[d])}</td></tr>`).join("")}</table>` : ""}
    <p class="addr">${esc(lead.address || "")}${lead.postcode ? `, ${esc(lead.postcode)}` : ""} ${esc(lead.city || "Paris")}</p>
    <div class="cta">
      ${lead.phone ? `<a class="btn btn-primary" href="${esc(telHref(lead.phone))}" data-ev="cta_call">${esc(frPhone(lead.phone))}</a>` : ""}
      ${lead.email ? `<a class="btn btn-ghost" href="mailto:${esc(lead.email)}">Écrire</a>` : ""}
      ${ig ? `<a class="btn btn-ghost" href="${esc(ig)}" target="_blank" rel="noopener">Instagram</a>` : ""}
    </div>
  </div>
  ${bbox ? `<iframe class="map" loading="lazy" title="Plan" src="https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lead.lat},${lead.lon}"></iframe>` : ""}
</div></div></section>
<footer><div class="wrap">© ${new Date().getFullYear()} ${esc(name)} · ${esc(lead.address || "")} ${esc(lead.postcode || "")} · Site par ${esc(env.AGENCY_NAME || "")}${demo ? " · Données © contributeurs OpenStreetMap" : ""}</div></footer>
<div class="sticky">${lead.phone ? `<a class="btn btn-primary" href="${esc(telHref(lead.phone))}" data-ev="cta_call">Appeler</a>` : ""}<a class="btn btn-ghost" href="${esc(mapsUrl)}" target="_blank" rel="noopener">Itinéraire</a></div>
${demo ? claimSheet(lead, env) : ""}
${mode === "demo" ? beacon(lead.slug) + chatWidget(lead, env) : ""}
</body></html>`;
}

function claimSheet(lead, env) {
  const checkout = checkoutUrl(env, lead.slug);
  return `<div class="claim" id="claim"><div class="sheet">
<a class="x" href="#" aria-label="Fermer">×</a>
<h3>Ce site, en ligne pour ${esc(lead.name)} sous ${esc(env.OFFER_DELAY || "48 h")}</h3>
<p style="color:#555">Sur votre propre adresse, avec vos vraies photos et vos textes.</p>
<div class="price"><b>${esc(env.OFFER_PRICE || "")}</b><span>puis ${esc(env.OFFER_MONTHLY || "")}, sans engagement</span></div>
<ul><li>Votre nom de domaine</li><li>Hébergement rapide et sécurisé</li><li>Pensé pour Google et le mobile</li><li>Modifications sur simple message</li></ul>
<form method="post" action="/c/${esc(lead.slug)}">
<input name="who" placeholder="Votre prénom" required maxlength="80">
<input name="phone" type="tel" placeholder="Votre téléphone" required maxlength="30">
<textarea name="msg" rows="2" placeholder="Un détail à changer ? (facultatif)" maxlength="600"></textarea>
<button type="submit">Je veux ce site</button>
</form>
${checkout ? `<a class="alt" href="${esc(checkout)}" data-ev="cta_pay">Ou réserver directement en ligne →</a>` : ""}
<p style="color:#888;font-size:13px;margin-top:14px">${esc(env.AGENCY_PERSON || "")} · ${esc(env.AGENCY_NAME || "")} · ${esc(env.AGENCY_PHONE || "")}<br>Pas intéressé ? <a href="/stop/${esc(lead.slug)}">Ne plus être contacté</a></p>
</div></div>`;
}

function chatWidget(lead, env) {
  const person = esc(env.AGENCY_PERSON || "notre équipe");
  const pay = checkoutUrl(env, lead.slug);
  return `<style>
.cw-btn{position:fixed;right:16px;bottom:16px;z-index:45;background:#111;color:#fff;border:0;border-radius:99px;padding:13px 18px;font:600 15px Inter,system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.25);cursor:pointer}
@media(max-width:860px){.cw-btn{bottom:84px}}
.cw{position:fixed;right:16px;bottom:16px;z-index:70;width:min(380px,calc(100vw - 24px));height:min(560px,calc(100vh - 90px));background:#fff;color:#151515;border-radius:22px;box-shadow:0 20px 60px rgba(0,0,0,.3);display:none;flex-direction:column;overflow:hidden;font:15px/1.45 Inter,system-ui,sans-serif}
.cw.open{display:flex}@media(max-width:600px){.cw{right:12px;left:12px;bottom:12px;width:auto;height:calc(100vh - 70px)}}
.cw-h{padding:14px 16px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center}.cw-h b{font-size:15px}.cw-h small{display:block;color:#888;font-size:12px}
.cw-x{background:none;border:0;font-size:24px;color:#999;cursor:pointer}
.cw-m{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:8px;background:#faf9f7}
.cw-m div{max-width:85%;padding:9px 12px;border-radius:16px;white-space:pre-wrap}
.cw-a{background:#fff;border:1px solid #eee;align-self:flex-start;border-bottom-left-radius:4px}.cw-u{background:#111;color:#fff;align-self:flex-end;border-bottom-right-radius:4px}
.cw-q{display:flex;gap:6px;flex-wrap:wrap;padding:8px 12px 0}.cw-q button{border:1px solid #ddd;background:#fff;border-radius:99px;padding:6px 10px;font:500 13px Inter,sans-serif;cursor:pointer}
.cw-act{display:flex;gap:8px;padding:8px 12px}.cw-act a{flex:1;text-align:center;text-decoration:none;border-radius:99px;padding:9px;font:600 14px Inter,sans-serif;background:#efede8;color:#111}.cw-act a.p{background:#1a7f4b;color:#fff}
.cw-f{display:flex;gap:8px;padding:10px 12px 12px;border-top:1px solid #eee}.cw-f input{flex:1;border:1px solid #ddd;border-radius:99px;padding:10px 14px;font:16px Inter,sans-serif}.cw-f button{background:#111;color:#fff;border:0;border-radius:99px;padding:0 16px;font:600 15px Inter,sans-serif}
</style>
<button class="cw-btn" data-ev="chat_open" id="cwOpen">💬 Une question ?</button>
<div class="cw" id="cw" role="dialog" aria-label="Assistant">
<div class="cw-h"><div><b>Assistant ${esc(env.AGENCY_NAME || "")}</b><small>IA · ${person} lit les échanges</small></div><button class="cw-x" id="cwX" aria-label="Fermer">×</button></div>
<div class="cw-m" id="cwM"><div class="cw-a">Bonjour 👋 Je suis l'assistant <b>IA</b> de ${esc(env.AGENCY_NAME || "l'agence")}. Je réponds à vos questions sur ce site : prix, délai, modifications. ${person} peut aussi vous rappeler.</div></div>
<div class="cw-q" id="cwQ"><button>Combien ça coûte ?</button><button>Je peux changer les photos ?</button><button>C'est en ligne quand ?</button><button>Rappelez-moi</button></div>
<div class="cw-act">${pay ? `<a class="p" href="${esc(pay)}" data-ev="cta_pay">Réserver</a>` : ""}<a href="#claim" data-ev="cta_claim">Être rappelé</a></div>
<form class="cw-f" id="cwF"><input id="cwI" placeholder="Votre question…" maxlength="500" autocomplete="off"><button>↑</button></form>
</div>
<script>(function(){var s=${JSON.stringify(lead.slug)},msgs=[],box=document.getElementById("cw"),m=document.getElementById("cwM"),inp=document.getElementById("cwI");
function add(t,who){var d=document.createElement("div");d.className=who==="user"?"cw-u":"cw-a";d.textContent=t;m.appendChild(d);m.scrollTop=m.scrollHeight;return d}
document.getElementById("cwOpen").onclick=function(){box.classList.add("open")};document.getElementById("cwX").onclick=function(){box.classList.remove("open")};
async function send(t){t=(t||"").trim();if(!t)return;add(t,"user");msgs.push({role:"user",content:t});inp.value="";var w=add("…","assistant");
try{var r=await fetch("/chat/"+s,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({messages:msgs})});var j=await r.json();w.textContent=j.reply||"Laissez votre numéro, on vous rappelle.";msgs.push({role:"assistant",content:w.textContent})}catch(e){w.textContent="Oups, réseau. Laissez votre numéro et on vous rappelle."}}
document.getElementById("cwF").onsubmit=function(e){e.preventDefault();send(inp.value)};
document.getElementById("cwQ").onclick=function(e){if(e.target.tagName!=="BUTTON")return;var t=e.target.textContent;if(t==="Rappelez-moi"){add(t,"user");add("Avec plaisir. À quel numéro ${esc(env.AGENCY_PERSON || "on")} peut vous rappeler ?","assistant");inp.placeholder="06 12 34 56 78";inp.focus()}else send(t)};
})();</script>`;
}

function beacon(slug) {
  return `<script>(function(){var s=${JSON.stringify(slug)};function ev(t){try{var b=JSON.stringify({t:t});if(navigator.sendBeacon){navigator.sendBeacon("/e/"+s,new Blob([b],{type:"text/plain"}))}else{fetch("/e/"+s,{method:"POST",body:b,keepalive:true})}}catch(e){}}
var sent=false;function v(){if(!sent&&document.visibilityState==="visible"){sent=true;ev("view")}}
setTimeout(v,1500);document.addEventListener("visibilitychange",function(){setTimeout(v,1500)});
document.addEventListener("click",function(e){var a=e.target.closest("[data-ev]");if(a)ev(a.getAttribute("data-ev"))});})();</script>`;
}

export function renderMessage(title, body, env) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font:17px/1.6 Inter,system-ui,sans-serif;background:#f4f2ee;color:#1a1a1a;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}main{background:#fff;max-width:460px;padding:34px;border-radius:24px}h1{font-size:26px;letter-spacing:-.02em;margin:0 0 10px}button{background:#111;color:#fff;border:0;border-radius:99px;padding:13px 22px;font:600 16px Inter,sans-serif;cursor:pointer;margin-top:14px}a{color:#111}</style></head>
<body><main><h1>${esc(title)}</h1>${body}<p style="color:#888;font-size:14px;margin-top:22px">${esc(env.AGENCY_NAME || "")} · ${esc(env.AGENCY_PHONE || "")}</p></main></body></html>`;
}

// ---------- admin hit list ----------
const STATUS_FR = { new: "Nouveau", contacted: "Contacté", opened: "A ouvert", hot: "🔥 Chaud", won: "Gagné", lost: "Perdu", optout: "Opt-out", churned: "Résilié" };

export function waNumber(phone) {
  let d = String(phone || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = "33" + d.slice(1);
  return d;
}
export const isMobileFR = (phone) => /^33[67]\d{8}$/.test(waNumber(phone));

function frDateISO(iso) {
  const d = new Date(iso + "T12:00:00Z");
  return isNaN(d) ? iso : new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" }).format(d);
}

function inboxBlock(l, subj) {
  const ib = l.inbox || {};
  const out = [];
  if (ib.claim) out.push(`📞 Demande de rappel : <b>${esc(ib.claim.phone || "")}</b>${ib.claim.msg ? ` « ${esc(String(ib.claim.msg).slice(0, 140))} »` : ""}`);
  if (ib.email_in) out.push(`📩 <b>${esc(ib.email_in.intent || "")}</b> : « ${esc(String(ib.email_in.text || "").slice(0, 220))} »`);
  if (ib.email_out) out.push(`🤖 L'IA a répondu : « ${esc(String(ib.email_out.text || "").slice(0, 160))}… »`);
  else if (ib.draft) out.push(`✍️ Brouillon IA : « ${esc(String(ib.draft.text || "").slice(0, 160))}… » <a href="mailto:${esc(ib.draft.to || l.email || "")}?subject=${encodeURIComponent("Re: " + (ib.draft.subject || subj))}&body=${encodeURIComponent(ib.draft.text || "")}">Envoyer</a>`);
  if (ib.chat && !ib.email_in) out.push(`💬 A demandé : « ${esc(String(ib.chat.q || "").slice(0, 140))} »`);
  return out.length ? `<div class="opener" style="background:#fff7e6">${out.join("<br>")}</div>` : "";
}

function ago(ts) {
  if (!ts) return "";
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 60) return `il y a ${m} min`;
  if (m < 1440) return `il y a ${Math.round(m / 60)} h`;
  return `il y a ${Math.round(m / 1440)} j`;
}

export function renderAdmin(leads, counts, q, env, origin) {
  const tabs = ["hot", "opened", "new", "contacted", "won", "lost"];
  const cards = leads.map((l) => {
    const c = safeJson(l.content);
    const o = c.outreach || {};
    const url = `${origin}/s/${l.slug}`;
    const sms = (o.sms || "").replaceAll("{url}", url).replaceAll("{stop}", `${origin}/stop/${l.slug}`);
    const mob = isMobileFR(l.phone);
    const audit = safeJson(l.audit);
    const badge = l.kind === "weak_site" ? `Site faible${audit.score != null ? ` ${audit.score}/100` : ""}` : "Sans site";
    const subj = o.email_subject || `${l.name} — maquette de site`;
    const body = (o.email_body || "").replaceAll("{url}", url).replaceAll("{stop}", `${origin}/stop/${l.slug}`);
    return `<article class="lead s-${esc(l.status)}" data-slug="${esc(l.slug)}">
<div class="row"><div><h3>${esc(l.name)}</h3><div class="meta">${esc(l.category || "")} · ${esc(arrondissement(l.postcode) || l.postcode || "")} · <span class="badge">${esc(badge)}</span></div></div>
<div class="views">${l.views ? `👀 ${l.views}<small>${esc(ago(l.last_view_at))}</small>` : ""}</div></div>
${(audit.reasons || []).length ? `<p class="meta" style="margin-top:8px">⚠️ ${esc(audit.reasons.join(" · "))}</p>` : ""}
${l.opened_on ? `<p class="meta" style="margin-top:8px">🆕 Ouvert le ${esc(frDateISO(l.opened_on))} (registre officiel)</p>` : ""}
${l.domain && l.status === "won" ? `<p class="meta" style="margin-top:8px">🌐 En ligne : <a href="https://${esc(l.domain)}" target="_blank">${esc(l.domain)}</a></p>` : ""}
${inboxBlock(l, subj)}
${!l.phone && !l.email ? `<p class="opener">🚶 À faire en visite : ${esc(o.walkin || "")}</p>` : o.call_opener ? `<p class="opener">${esc(o.call_opener)}</p>` : ""}
${l.email_step ? `<p class="meta" style="margin-top:6px">✉️ ${l.email_step} email${l.email_step > 1 ? "s" : ""} envoyé${l.email_step > 1 ? "s" : ""} automatiquement</p>` : ""}
<div class="acts">
<a href="/p/${esc(l.slug)}" target="_blank">Démo</a>
${l.phone ? `<a href="${esc(telHref(l.phone))}">📞 Appeler</a>` : ""}
${mob ? `<a href="https://wa.me/${waNumber(l.phone)}?text=${encodeURIComponent(sms)}" target="_blank">WhatsApp</a><a href="sms:+${waNumber(l.phone)}?&body=${encodeURIComponent(sms)}">SMS</a>` : ""}
${l.email ? `<a href="mailto:${esc(l.email)}?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(body)}">Email</a>` : ""}
${safeUrl(l.instagram) ? `<a href="${esc(l.instagram)}" target="_blank">Insta</a>` : ""}
<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${l.name} ${l.address || ""} ${l.postcode || ""}`)}" target="_blank">Y aller</a>
<button data-copy="${esc(url)}">Copier lien</button>
</div>
<div class="st">${["contacted", "won", "lost"].map((s) => `<button data-st="${s}" class="${l.status === s ? "on" : ""}">${STATUS_FR[s]}</button>`).join("")}<a href="/admin/edit/${esc(l.slug)}">Modifier</a><span class="cur">${esc(STATUS_FR[l.status] || l.status)}</span></div>
</article>`;
  }).join("");
  const pcs = [...new Set(leads.map((l) => l.postcode).filter(Boolean))].sort();
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Hit list</title>
<style>
*{box-sizing:border-box}body{margin:0;font:15px/1.45 Inter,system-ui,sans-serif;background:#f3f2ef;color:#151515}
.top{position:sticky;top:0;background:#151515;color:#fff;padding:12px 14px;z-index:5}
.k{display:flex;gap:8px;overflow:auto;padding-bottom:2px}.k a{flex:none;color:#fff;text-decoration:none;background:#2a2a2a;border-radius:99px;padding:6px 12px;font-size:13px}.k a.on{background:#fff;color:#111}
.k b{margin-left:4px}
form.f{display:flex;gap:8px;margin-top:10px}form.f select,form.f input{flex:1;padding:8px;border-radius:10px;border:0;font:inherit}
main{padding:12px;max-width:760px;margin:0 auto}
.lead{background:#fff;border-radius:18px;padding:16px;margin-bottom:12px;border:1px solid #e6e3dd}
.lead.s-hot{border:2px solid #e0533d}.lead.s-opened{border:2px solid #f3b21b}
.row{display:flex;justify-content:space-between;gap:10px}h3{margin:0;font-size:17px}
.meta{color:#666;font-size:13px;margin-top:2px}.badge{background:#f1efe9;border-radius:6px;padding:1px 6px}
.views{text-align:right;font-weight:600;white-space:nowrap}.views small{display:block;font-weight:400;color:#888;font-size:12px}
.opener{background:#f7f6f3;border-radius:10px;padding:8px 10px;font-size:13.5px;color:#444;margin:10px 0 0}
.acts,.st{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.acts a,.acts button,.st button,.st a{font:600 13.5px Inter,sans-serif;text-decoration:none;color:#111;background:#efede8;border:0;border-radius:99px;padding:8px 12px;cursor:pointer}
.acts a:first-child{background:#111;color:#fff}
.st button.on{background:#111;color:#fff}.st .cur{margin-left:auto;color:#888;font-size:12px;align-self:center}
.empty{text-align:center;color:#888;padding:40px}
</style></head><body>
<div class="top"><div class="k">${tabs.map((s) => `<a class="${q.status === s ? "on" : ""}" href="?status=${s}${q.pc ? `&pc=${q.pc}` : ""}">${STATUS_FR[s]}<b>${counts[s] || 0}</b></a>`).join("")}<a class="${!q.status ? "on" : ""}" href="?">Tout</a></div>
<form class="f"><input type="hidden" name="status" value="${esc(q.status || "")}"><select name="pc" onchange="this.form.submit()"><option value="">Tous arrondissements</option>${pcs.map((p) => `<option ${q.pc === p ? "selected" : ""}>${esc(p)}</option>`).join("")}</select></form></div>
<main>${cards || '<div class="empty">Rien ici. Lance le pipeline.</div>'}</main>
<script>
document.addEventListener("click",async function(e){
 var c=e.target.closest("[data-copy]");if(c){navigator.clipboard.writeText(c.dataset.copy);c.textContent="Copié ✓";return}
 var b=e.target.closest("[data-st]");if(!b)return;var art=b.closest("article");
 var r=await fetch("/admin/status",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({slug:art.dataset.slug,status:b.dataset.st})});
 if(r.ok){art.querySelectorAll("[data-st]").forEach(function(x){x.classList.toggle("on",x===b)});art.querySelector(".cur").textContent=b.textContent}
});
</script></body></html>`;
}

export function renderEdit(lead) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Modifier ${esc(lead.name)}</title>
<style>body{font:15px/1.5 Inter,system-ui,sans-serif;background:#f3f2ef;margin:0;padding:16px}main{max-width:760px;margin:0 auto;background:#fff;border-radius:18px;padding:18px}label{display:block;font-weight:600;margin:12px 0 4px}input,textarea,select{width:100%;font:14px ui-monospace,monospace;padding:10px;border:1px solid #ddd;border-radius:10px;box-sizing:border-box}textarea{min-height:360px}button{margin-top:14px;background:#111;color:#fff;border:0;border-radius:99px;padding:12px 20px;font:600 15px Inter,sans-serif}</style></head>
<body><main><a href="/admin">← Hit list</a><h2>${esc(lead.name)}</h2>
<form method="post">
<label>Nom</label><input name="name" value="${esc(lead.name)}">
<label>Téléphone</label><input name="phone" value="${esc(lead.phone || "")}">
<label>Horaires (format OSM, ex. Mo-Fr 09:00-19:00; Sa 10:00-18:00)</label><input name="hours" value="${esc(lead.hours || "")}">
<label>Domaine du client (rempli = site live, sans bandeau)</label><input name="domain" value="${esc(lead.domain || "")}" placeholder="boulangerie-martin.fr">
<label>Statut</label><select name="status">${Object.keys(STATUS_FR).map((s) => `<option ${lead.status === s ? "selected" : ""} value="${s}">${STATUS_FR[s]}</option>`).join("")}</select>
<label>Notes</label><input name="notes" value="${esc(lead.notes || "")}">
<label>Contenu (JSON)</label><textarea name="content">${esc(JSON.stringify(safeJson(lead.content), null, 2))}</textarea>
<button>Enregistrer</button> <a href="/p/${esc(lead.slug)}" target="_blank">Voir</a>
</form></main></body></html>`;
}

export function safeJson(s) {
  if (!s) return {};
  if (typeof s === "object") return s;
  try { return JSON.parse(s); } catch { return {}; }
}
