// Cash Engine Worker: serves demo sites, tracks real opens, pings your phone,
// takes claims, handles opt-outs, gives you a mobile hit list, and serves
// won clients' live sites on their own domain.
import { renderSite, renderAdmin, renderEdit, renderMessage, esc, safeJson, frDate, waNumber, frPhone, checkoutUrl } from "./render.js";
import { chat } from "./closer.js";
import { handleEmail } from "./inbox.js";
import { stripeWebhook, thankYou } from "./stripe.js";

// Link scanners and preview bots must never trigger a "they opened it" alert.
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|slack|discord|skype|linkedin|twitter|applebot|googleimageproxy|google-read-aloud|bing|yandex|curl|wget|python|httpclient|okhttp|headless|lighthouse|proofpoint|mimecast|barracuda|scanner|monitor/i;
const DAY = 86400000;

export default {
  async fetch(req, env, ctx) {
    try {
      return await route(req, env, ctx);
    } catch (e) {
      console.error(e && e.stack ? e.stack : e);
      return new Response("Erreur interne", { status: 500 });
    }
  },
  // Cloudflare Email Routing -> AI inbox
  async email(message, env, ctx) {
    const { EmailMessage } = await import("cloudflare:email");
    return handleEmail(message, env, ctx, EmailMessage, { notify });
  },
  // Cron (wrangler.toml [triggers]): evening digest on your phone
  async scheduled(event, env, ctx) {
    ctx.waitUntil(digest(env, ctx));
  },
};

export async function digest(env, ctx) {
  const since = Date.now() - DAY;
  const { results } = await env.DB.prepare("SELECT type, COUNT(*) AS n FROM events WHERE at > ? GROUP BY type").bind(since).all();
  const c = Object.fromEntries(results.map((r) => [r.type, r.n]));
  const paid = await env.DB.prepare("SELECT COALESCE(SUM(json_extract(meta, '$.amount')), 0) AS cents FROM events WHERE type = 'paid' AND at > ?").bind(since).first();
  const mrr = await env.DB.prepare("SELECT COUNT(*) AS n FROM leads WHERE status = 'won'").first();
  const hot = await env.DB.prepare("SELECT COUNT(*) AS n FROM leads WHERE status = 'hot'").first();
  const msg = `👀 ${c.view || 0} ouvertures · 💬 ${c.chat || 0} questions · 📩 ${c.email_in || 0} réponses\n📞 ${c.claim || 0} demandes de rappel · 🔥 ${hot.n} leads chauds en attente\n💸 ${((paid.cents || 0) / 100).toFixed(0)} € encaissés aujourd'hui · ${mrr.n} clients actifs`;
  notify(env, ctx, { title: "Bilan du jour", message: msg, priority: 3, click: `${String(env.PUBLIC_URL || "").replace(/\/$/, "")}/admin?status=hot` });
  return msg;
}

async function route(req, env, ctx) {
  const url = new URL(req.url);
  const p = url.pathname;
  const m = req.method;
  const host = url.hostname.replace(/^www\./, "");

  // 1) A won client's own domain -> live site, no banner, indexable.
  const isDemoHost = env.DEMO_HOST ? host === env.DEMO_HOST : host.endsWith(".workers.dev") || host === "localhost" || host === "127.0.0.1";
  if (!isDemoHost) {
    const live = await env.DB.prepare("SELECT * FROM leads WHERE domain = ?").bind(host).first();
    if (live && live.status === "won") {
      if (p === "/robots.txt") return text("User-agent: *\nAllow: /\n");
      return html(renderSite(live, env, "live"), 200, { "cache-control": "public, max-age=300" });
    }
    if (live && live.status === "churned")
      return html(renderMessage("Site momentanément indisponible", `<p>Le site de <b>${esc(live.name)}</b> est en pause.</p>${live.phone ? `<p>Contact : <a href="tel:${esc(String(live.phone).replace(/[^\d+]/g, ""))}">${esc(frPhone(live.phone))}</a></p>` : ""}`, env), 503);
  }

  if (p === "/robots.txt") return text("User-agent: *\nDisallow: /\n");
  if (p === "/" || p === "") return html(renderMessage(env.AGENCY_NAME || "Studio", `<p>Sites pour les commerces parisiens.</p><p><a href="tel:${esc(String(env.AGENCY_PHONE || "").replace(/\s/g, ""))}">${esc(env.AGENCY_PHONE || "")}</a></p>`, env));

  let mm;
  if ((mm = p.match(/^\/s\/([a-z0-9-]{3,80})$/)) && m === "GET") return demo(req, env, mm[1], (await isAdmin(req, env)) ? "preview" : "demo");
  if ((mm = p.match(/^\/p\/([a-z0-9-]{3,80})$/)) && m === "GET") {
    if (!(await isAdmin(req, env))) return Response.redirect(`${url.origin}/s/${mm[1]}`, 302);
    return demo(req, env, mm[1], "preview");
  }
  if ((mm = p.match(/^\/e\/([a-z0-9-]{3,80})$/)) && m === "POST") return beacon(req, env, ctx, mm[1]);
  if ((mm = p.match(/^\/c\/([a-z0-9-]{3,80})$/)) && m === "POST") return claim(req, env, ctx, mm[1]);
  if ((mm = p.match(/^\/stop\/([a-z0-9-]{3,80})$/))) return stop(req, env, ctx, mm[1]);
  if ((mm = p.match(/^\/chat\/([a-z0-9-]{3,80})$/)) && m === "POST") {
    const lead = await getLead(env, mm[1]);
    if (!lead || ["skip", "optout", "lost"].includes(lead.status)) return json({ reply: "Cette maquette n'est plus disponible." });
    return chat(req, env, ctx, lead, { json, notify, origin: url.origin });
  }
  if (p === "/stripe/webhook" && m === "POST") return stripeWebhook(req, env, ctx, { notify, json });
  if (p === "/merci") {
    const lead = await thankYou(env, url);
    const person = esc(env.AGENCY_PERSON || "Nous");
    const wa = waNumber(env.AGENCY_PHONE || "");
    const live = lead && lead.domain ? `https://${lead.domain}` : "";
    return html(renderMessage("Merci, c'est parti 🎉", `${lead ? `<p>Le site de <b>${esc(lead.name)}</b> ${live ? `est déjà en ligne : <a href="${esc(live)}">${esc(lead.domain)}</a>` : "sera en ligne très vite"}.</p>` : "<p>Paiement reçu. Votre site sera en ligne très vite.</p>"}
<p>Prochaine étape : envoyez vos photos (devanture, intérieur, produits) et vos textes à ${person}. Il met tout en place sous ${esc(env.OFFER_DELAY || "48 h")}.</p>
${wa ? `<p><a href="https://wa.me/${wa}?text=${encodeURIComponent(`Bonjour, c'est ${lead ? lead.name : "un nouveau client"}. Voici mes photos et textes pour le site :`)}"><button type="button">Envoyer mes photos sur WhatsApp</button></a></p>` : ""}
<p style="color:#666;font-size:15px">Vous voulez votre propre nom de domaine (ex. ${esc(lead ? lead.name.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "") : "monsalon")}.fr) ? Dites-le à ${person}, il s'en occupe.</p>`, env));
  }

  if (p === "/admin" && m === "GET") return admin(req, env, url);
  if (p === "/admin/status" && m === "POST") return adminStatus(req, env);
  if ((mm = p.match(/^\/admin\/edit\/([a-z0-9-]{3,80})$/))) return adminEdit(req, env, mm[1], url);

  if (p.startsWith("/api/")) return api(req, env, url);
  return html(renderMessage("Page introuvable", "<p>Ce lien n'existe pas ou plus.</p>", env), 404);
}

// ---------------- demo ----------------
async function demo(req, env, slug, mode) {
  const lead = await getLead(env, slug);
  if (!lead || lead.status === "skip" || lead.status === "optout" || !lead.content)
    return html(renderMessage("Page introuvable", "<p>Cette maquette n'existe pas ou plus.</p>", env), 404);
  if (mode === "demo" && lead.status !== "won" && lead.expires_at && Date.now() > lead.expires_at)
    return html(renderMessage("Cette maquette a expiré", `<p>La maquette préparée pour <b>${esc(lead.name)}</b> n'est plus en ligne.</p><p>Elle peut être réactivée en un message : <a href="tel:${esc(String(env.AGENCY_PHONE || "").replace(/\s/g, ""))}">${esc(env.AGENCY_PHONE || "")}</a></p>`, env), 410);
  return html(renderSite(lead, env, mode), 200, { "x-robots-tag": "noindex, nofollow", "cache-control": "no-store" });
}

async function beacon(req, env, ctx, slug) {
  const nothing = new Response(null, { status: 204 });
  const ua = req.headers.get("user-agent") || "";
  if (!ua || BOT_UA.test(ua) || (await isAdmin(req, env))) return nothing;
  let t = "view";
  try { t = JSON.parse(await req.text()).t || "view"; } catch {}
  if (!["view", "cta_call", "cta_claim", "cta_pay", "chat_open"].includes(t)) return nothing;
  const lead = await getLead(env, slug);
  if (!lead || ["skip", "optout", "won", "lost"].includes(lead.status)) return nothing;

  const now = Date.now();
  const where = [req.cf?.city, req.cf?.country].filter(Boolean).join(", ");
  await env.DB.prepare("INSERT INTO events (slug, type, at, meta) VALUES (?, ?, ?, ?)")
    .bind(slug, t, now, JSON.stringify({ ua: ua.slice(0, 160), where })).run();

  const call = lead.phone ? `tel:${String(lead.phone).replace(/[^\d+]/g, "")}` : undefined;
  const actions = call ? [{ action: "view", label: "📞 Appeler", url: call }] : undefined;
  const click = `${new URL(req.url).origin}/admin?status=opened`;

  if (t === "view") {
    const row = await env.DB.prepare(
      `UPDATE leads SET views = views + 1, last_view_at = ?, first_view_at = COALESCE(first_view_at, ?),
       status = CASE WHEN status IN ('new','contacted') THEN 'opened' ELSE status END
       WHERE slug = ? RETURNING views`
    ).bind(now, now, slug).first();
    const v = row ? row.views : 0;
    if (v === 1) notify(env, ctx, { title: `👀 ${lead.name} ouvre sa démo`, message: `${lead.category || ""} ${lead.postcode || ""} · ${where || "?"}\nAppelle dans les 5 min : ${lead.phone || "pas de tél."}`, priority: 4, click, actions });
    else if (v === 3) notify(env, ctx, { title: `🔥 ${lead.name} : 3e visite`, message: `Il hésite. Appelle maintenant : ${lead.phone || ""}`, priority: 5, click, actions });
  } else if (t === "cta_claim") {
    notify(env, ctx, { title: `💰 ${lead.name} regarde le prix`, message: `Appelle maintenant : ${lead.phone || ""}`, priority: 5, click, actions });
  } else if (t === "cta_pay") {
    notify(env, ctx, { title: `💳 ${lead.name} ouvre le paiement`, message: `S'il ne paie pas dans 10 min, appelle : ${lead.phone || ""}`, priority: 5, click, actions });
  }
  return nothing;
}

async function claim(req, env, ctx, slug) {
  const lead = await getLead(env, slug);
  if (!lead || ["skip", "optout"].includes(lead.status)) return html(renderMessage("Page introuvable", "", env), 404);
  const f = await req.formData();
  const who = String(f.get("who") || "").slice(0, 80);
  const phone = String(f.get("phone") || "").slice(0, 30);
  const msg = String(f.get("msg") || "").slice(0, 600);
  if (!phone.replace(/\D/g, "")) return html(renderMessage("Il manque votre numéro", `<p><a href="/s/${esc(slug)}#claim">Revenir</a></p>`, env), 400);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO events (slug, type, at, meta) VALUES (?, 'claim', ?, ?)").bind(slug, now, JSON.stringify({ who, phone, msg })),
    env.DB.prepare("UPDATE leads SET status = CASE WHEN status = 'won' THEN 'won' ELSE 'hot' END, notes = TRIM(COALESCE(notes,'') || ' | claim: ' || ?) WHERE slug = ?").bind(`${who} ${phone} ${msg}`, slug),
  ]);
  notify(env, ctx, {
    title: `💸 ${lead.name} VEUT LE SITE`,
    message: `${who} · ${phone}\n${msg}`,
    priority: 5,
    tags: ["moneybag"],
    click: `${new URL(req.url).origin}/admin?status=hot`,
    actions: [{ action: "view", label: "📞 Rappeler", url: `tel:${phone.replace(/[^\d+]/g, "")}` }],
  });
  const checkout = checkoutUrl(env, slug);
  return html(renderMessage("C'est noté 🙌", `<p>Merci ${esc(who)} ! ${esc(env.AGENCY_PERSON || "On")} vous rappelle très vite au ${esc(phone)} pour mettre le site de <b>${esc(lead.name)}</b> en ligne.</p>${checkout ? `<p><a href="${esc(checkout)}"><button type="button">Réserver maintenant</button></a></p>` : ""}`, env));
}

async function stop(req, env, ctx, slug) {
  const lead = await getLead(env, slug);
  if (!lead) return html(renderMessage("C'est noté", "<p>Vous ne serez plus contacté.</p>", env));
  if (req.method !== "POST")
    return html(renderMessage("Ne plus être contacté", `<p>Confirmez et nous ne contacterons plus <b>${esc(lead.name)}</b>. La maquette sera supprimée.</p><form method="post"><button>Confirmer</button></form>`, env));
  const now = Date.now();
  const keys = [lead.phone && waNumber(lead.phone), lead.email && String(lead.email).toLowerCase().trim()].filter(Boolean);
  await env.DB.batch([
    ...keys.map((k) => env.DB.prepare("INSERT OR IGNORE INTO suppress (key, at) VALUES (?, ?)").bind(k, now)),
    env.DB.prepare("UPDATE leads SET status = 'optout' WHERE slug = ?").bind(slug),
    env.DB.prepare("INSERT INTO events (slug, type, at, meta) VALUES (?, 'optout', ?, '{}')").bind(slug, now),
  ]);
  notify(env, ctx, { title: `Opt-out : ${lead.name}`, message: "Ne plus contacter.", priority: 2 });
  return html(renderMessage("C'est noté", "<p>Vous ne serez plus contacté. Désolé pour le dérangement.</p>", env));
}

// ---------------- admin ----------------
async function admin(req, env, url) {
  const k = url.searchParams.get("k");
  if (k && env.ADMIN_KEY && k === env.ADMIN_KEY) {
    return new Response(null, {
      status: 302,
      headers: { location: "/admin", "set-cookie": `ce=${await sha(env.ADMIN_KEY)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000` },
    });
  }
  if (!(await isAdmin(req, env))) return html(renderMessage("Accès refusé", "<p>Ouvre /admin?k=TA_CLE une fois sur ce téléphone.</p>", env), 401);
  const q = { status: url.searchParams.get("status") || "", pc: url.searchParams.get("pc") || "" };
  const where = ["status NOT IN ('skip','optout')"], args = [];
  if (q.status) { where.push("status = ?"); args.push(q.status); }
  else where.push("status NOT IN ('lost')");
  if (q.pc) { where.push("postcode = ?"); args.push(q.pc); }
  const { results } = await env.DB.prepare(
    `SELECT slug, name, category, postcode, kind, phone, email, instagram, address, status, views, last_view_at, content, audit, expires_at, opened_on, source, email_step, domain
     FROM leads WHERE ${where.join(" AND ")}
     ORDER BY CASE status WHEN 'hot' THEN 0 WHEN 'opened' THEN 1 WHEN 'new' THEN 2 WHEN 'contacted' THEN 3 ELSE 4 END,
              last_view_at DESC, score DESC LIMIT 300`
  ).bind(...args).all();
  const { results: cs } = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM leads GROUP BY status").all();
  const counts = Object.fromEntries(cs.map((r) => [r.status, r.n]));
  const days = parseInt(env.DEMO_DAYS || "14", 10);
  for (const l of results) {
    const exp = frDate(l.expires_at || Date.now() + days * DAY);
    const c = safeJson(l.content);
    if (c.outreach) for (const key of Object.keys(c.outreach)) c.outreach[key] = String(c.outreach[key]).replaceAll("{expiry}", exp);
    l.content = c;
  }
  const slugs = results.map((l) => l.slug);
  const inbox = {};
  for (let i = 0; i < slugs.length; i += 90) {
    const part = slugs.slice(i, i + 90);
    const { results: ev } = await env.DB.prepare(
      `SELECT slug, type, meta FROM events WHERE type IN ('email_in','draft','email_out','chat','claim') AND slug IN (${part.map(() => "?").join(",")}) ORDER BY at ASC`
    ).bind(...part).all();
    for (const e of ev) (inbox[e.slug] ||= {})[e.type] = safeJson(e.meta);
  }
  for (const l of results) l.inbox = inbox[l.slug] || {};
  const page = renderAdmin(results, counts, q, env, url.origin)
    // tapping WhatsApp / SMS / Email marks the lead as contacted (starts the demo countdown)
    .replace("</script>", `document.addEventListener("click",function(e){var a=e.target.closest(".acts a");if(!a)return;var t=a.textContent.trim();if(["WhatsApp","SMS","Email"].indexOf(t)<0)return;var art=a.closest("article");fetch("/admin/status",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({slug:art.dataset.slug,status:"contacted",soft:true})})});</script>`);
  return html(page);
}

async function adminStatus(req, env) {
  if (!(await isAdmin(req, env))) return json({ error: "unauthorized" }, 401);
  const { slug, status, soft } = await req.json();
  const ok = ["new", "contacted", "opened", "hot", "won", "lost", "churned"];
  if (!ok.includes(status)) return json({ error: "bad status" }, 400);
  await setStatus(env, [slug], status, !!soft);
  return json({ ok: true });
}

async function setStatus(env, slugs, status, soft) {
  const now = Date.now();
  const days = parseInt(env.DEMO_DAYS || "14", 10);
  const stmts = slugs.map((s) =>
    status === "contacted"
      ? env.DB.prepare(
          `UPDATE leads SET status = CASE WHEN ${soft ? "status IN ('new')" : "1"} THEN 'contacted' ELSE status END,
           contacted_at = COALESCE(contacted_at, ?), expires_at = COALESCE(expires_at, ?) WHERE slug = ?`
        ).bind(now, now + days * DAY, s)
      : env.DB.prepare("UPDATE leads SET status = ? WHERE slug = ?").bind(status, s)
  );
  if (stmts.length) await env.DB.batch(stmts);
}

async function adminEdit(req, env, slug, url) {
  if (!(await isAdmin(req, env))) return html(renderMessage("Accès refusé", "", env), 401);
  const lead = await getLead(env, slug);
  if (!lead) return html(renderMessage("Introuvable", "", env), 404);
  if (req.method === "POST") {
    const f = await req.formData();
    let content = String(f.get("content") || "{}");
    try { content = JSON.stringify(JSON.parse(content)); } catch { return html(renderMessage("JSON invalide", `<p><a href="${url.pathname}">Revenir</a></p>`, env), 400); }
    const domain = String(f.get("domain") || "").toLowerCase().trim().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "") || null;
    await env.DB.prepare("UPDATE leads SET name = ?, phone = ?, hours = ?, domain = ?, status = ?, notes = ?, content = ? WHERE slug = ?")
      .bind(String(f.get("name") || lead.name), String(f.get("phone") || ""), String(f.get("hours") || ""), domain, String(f.get("status") || lead.status), String(f.get("notes") || ""), content, slug).run();
    return Response.redirect(`${url.origin}${url.pathname}`, 303);
  }
  return html(renderEdit(lead));
}

// ---------------- pipeline API (Bearer ADMIN_KEY) ----------------
const COLS = ["slug", "osm_id", "name", "category", "cat_key", "theme", "kind", "address", "postcode", "city", "lat", "lon", "phone", "email", "instagram", "facebook", "website", "hours", "audit", "content", "score", "source", "opened_on"];

async function api(req, env, url) {
  const auth = req.headers.get("authorization") || "";
  if (!env.ADMIN_KEY || auth !== `Bearer ${env.ADMIN_KEY}`) return json({ error: "unauthorized" }, 401);
  const p = url.pathname;

  if (p === "/api/leads" && req.method === "POST") {
    const { leads = [] } = await req.json();
    const now = Date.now();
    const stmts = leads.slice(0, 500).map((l) => {
      const vals = COLS.map((c) => {
        const v = l[c];
        if (v === undefined || v === null || v === "") return null;
        return typeof v === "object" ? JSON.stringify(v) : v;
      });
      return env.DB.prepare(
        `INSERT INTO leads (${COLS.join(",")}, status, created_at) VALUES (${COLS.map(() => "?").join(",")}, ?, ?) ON CONFLICT(osm_id) DO NOTHING`
      ).bind(...vals, l.kind === "skip" ? "skip" : "new", now);
    });
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    return json({ ok: true, received: stmts.length });
  }

  if (p === "/api/known" && req.method === "GET") {
    const { results } = await env.DB.prepare("SELECT osm_id FROM leads WHERE osm_id IS NOT NULL").all();
    const { results: sup } = await env.DB.prepare("SELECT key FROM suppress").all();
    return json({ osm_ids: results.map((r) => r.osm_id), suppress: sup.map((r) => r.key) });
  }

  if (p === "/api/outbox" && req.method === "GET") {
    // What's due today in the email sequence (max 3 emails per lead, threaded):
    //   initial : never emailed
    //   bump    : 1 sent, not opened after 3 days
    //   opened  : opened the demo but no reply/claim after 2 days (once)
    //   last    : 2 sent, still nothing after 5 days -> "expires on ..."
    const limit = parseInt(url.searchParams.get("limit") || "25", 10);
    const now = Date.now();
    const { results } = await env.DB.prepare(
      `SELECT slug, name, email, phone, postcode, content, kind, status, views, email_step AS step, last_email_at, email_msgid AS msgid, expires_at,
        CASE
          WHEN email_step = 0 AND status = 'new' THEN 'initial'
          WHEN email_step = 1 AND status = 'contacted' AND last_email_at < ?1 THEN 'bump'
          WHEN email_step IN (1, 2) AND status = 'opened' AND last_email_at < ?2 THEN 'opened'
          WHEN email_step = 2 AND status = 'contacted' AND last_email_at < ?3 THEN 'last'
        END AS which
       FROM leads
       WHERE email IS NOT NULL AND content IS NOT NULL AND email_step < 3
         AND status IN ('new', 'contacted', 'opened')
         AND (expires_at IS NULL OR expires_at > ?4)
       ORDER BY CASE WHEN email_step = 0 THEN 1 ELSE 0 END, score DESC`
    ).bind(now - 3 * DAY, now - 2 * DAY, now - 5 * DAY, now).all();
    const { results: sup } = await env.DB.prepare("SELECT key FROM suppress").all();
    const blocked = new Set(sup.map((r) => r.key));
    // a lead gets at most one "opened" nudge
    const nudged = new Set((await env.DB.prepare("SELECT DISTINCT slug FROM events WHERE type = 'email_nudge'").all()).results.map((r) => r.slug));
    const due = results
      .filter((l) => l.which && !blocked.has(String(l.email).toLowerCase()) && !(l.phone && blocked.has(waNumber(l.phone))))
      .filter((l) => !(l.which === "opened" && nudged.has(l.slug)))
      .slice(0, limit);
    const days = parseInt(env.DEMO_DAYS || "14", 10);
    return json({
      expiry: frDate(now + days * DAY),
      items: due.map((l) => ({ ...l, expiry: l.expires_at ? frDate(l.expires_at) : null })),
    });
  }

  if (p === "/api/emailed" && req.method === "POST") {
    const { items = [] } = await req.json();
    const now = Date.now();
    const days = parseInt(env.DEMO_DAYS || "14", 10);
    const stmts = [];
    for (const it of items) {
      stmts.push(env.DB.prepare(
        `UPDATE leads SET email_step = email_step + 1, last_email_at = ?, email_msgid = COALESCE(email_msgid, ?),
         status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END,
         contacted_at = COALESCE(contacted_at, ?), expires_at = COALESCE(expires_at, ?) WHERE slug = ?`
      ).bind(now, it.msgid || null, now, now + days * DAY, it.slug));
      stmts.push(env.DB.prepare("INSERT INTO events (slug, type, at, meta) VALUES (?, ?, ?, ?)").bind(it.slug, it.which === "opened" ? "email_nudge" : "email_sent", now, JSON.stringify({ which: it.which || "" })));
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true });
  }

  if (p === "/api/stats" && req.method === "GET") {
    const { results } = await env.DB.prepare("SELECT status, COUNT(*) AS n, SUM(views) AS views FROM leads GROUP BY status").all();
    const since = Date.now() - 7 * DAY;
    const { results: ev } = await env.DB.prepare("SELECT type, COUNT(*) AS n FROM events WHERE at > ? GROUP BY type").bind(since).all();
    return json({ by_status: results, events_7d: ev });
  }
  return json({ error: "not found" }, 404);
}

// ---------------- helpers ----------------
const getLead = (env, slug) => env.DB.prepare("SELECT * FROM leads WHERE slug = ?").bind(slug).first();

export function notify(env, ctx, msg) {
  if (!env.NTFY_TOPIC) return;
  const body = JSON.stringify({ topic: env.NTFY_TOPIC, ...msg });
  const job = fetch("https://ntfy.sh/", { method: "POST", headers: { "content-type": "application/json" }, body }).catch(() => {});
  ctx && ctx.waitUntil ? ctx.waitUntil(job) : job;
}

async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function isAdmin(req, env) {
  if (!env.ADMIN_KEY) return false;
  const c = req.headers.get("cookie") || "";
  const m = c.match(/(?:^|;\s*)ce=([a-f0-9]{64})/);
  return !!m && m[1] === (await sha(env.ADMIN_KEY));
}

const html = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
const text = (body) => new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
