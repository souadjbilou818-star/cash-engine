// Stripe -> automatic delivery.
// checkout.session.completed   : lead = won, site goes live instantly on <name>.<CLIENT_ZONE>, money push.
// customer.subscription.deleted: site suspended (shows a polite page), push.
// invoice.payment_failed       : push so you can chase it.
// Signature is verified (HMAC-SHA256, 5-minute tolerance); unsigned calls are rejected.

async function hmacHex(secret, payload) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function verifyStripe(raw, header, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!header || !secret) return false;
  const v1 = [];
  let t = null;
  for (const kv of header.split(",")) {
    const [k, v] = kv.split("=");
    if (k === "t") t = parseInt(v, 10);
    if (k === "v1") v1.push(v);
  }
  if (!t || !v1.length || Math.abs(nowSec - t) > 300) return false;
  const expected = await hmacHex(secret, `${t}.${raw}`);
  return v1.some((s) => safeEqual(s, expected));
}

export function subdomainFor(slug, zone) {
  const base = slug.replace(/-[0-9a-f]{4}$/, "").slice(0, 50).replace(/-+$/, "");
  return zone ? `${base}.${zone}` : null;
}

export async function stripeWebhook(req, env, ctx, deps) {
  const { notify, json } = deps;
  const raw = await req.text();
  if (!(await verifyStripe(raw, req.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET))) return json({ error: "bad signature" }, 400);
  const evt = JSON.parse(raw);
  const o = (evt.data && evt.data.object) || {};
  const now = Date.now();
  const origin = String(env.PUBLIC_URL || "").replace(/\/$/, "");

  if (evt.type === "checkout.session.completed") {
    const slug = o.client_reference_id;
    const lead = slug ? await env.DB.prepare("SELECT * FROM leads WHERE slug = ?").bind(slug).first() : null;
    const amount = o.amount_total != null ? `${(o.amount_total / 100).toFixed(2).replace(".", ",")} ${String(o.currency || "eur").toUpperCase()}` : "";
    if (!lead) {
      notify(env, ctx, { title: `💸 Paiement reçu ${amount}`, message: `Sans lead associé (client_reference_id: ${slug || "aucun"}). Vérifie Stripe.`, priority: 5 });
      return json({ ok: true });
    }
    let domain = lead.domain;
    if (!domain && env.CLIENT_ZONE) {
      domain = subdomainFor(slug, env.CLIENT_ZONE);
      const taken = await env.DB.prepare("SELECT slug FROM leads WHERE domain = ? AND slug != ?").bind(domain, slug).first();
      if (taken) domain = `${slug}.${env.CLIENT_ZONE}`;
    }
    const email = (o.customer_details && o.customer_details.email) || o.customer_email || null;
    await env.DB.batch([
      env.DB.prepare("UPDATE leads SET status = 'won', paid_at = ?, stripe_customer = COALESCE(?, stripe_customer), client_email = COALESCE(?, client_email), domain = ? WHERE slug = ?")
        .bind(now, o.customer || null, email, domain, slug),
      env.DB.prepare("INSERT INTO events (slug, type, at, meta) VALUES (?, 'paid', ?, ?)").bind(slug, now, JSON.stringify({ amount: o.amount_total, currency: o.currency, session: o.id, email })),
    ]);
    notify(env, ctx, {
      title: `💸💸 PAYÉ ${amount} : ${lead.name}`,
      message: domain ? `En ligne maintenant : https://${domain}\nRécupère ses photos et textes.` : "Ajoute son domaine dans « Modifier ».",
      priority: 5, tags: ["moneybag"], click: domain ? `https://${domain}` : `${origin}/admin?status=won`,
    });
    return json({ ok: true });
  }

  if (evt.type === "customer.subscription.deleted" && o.customer) {
    const lead = await env.DB.prepare("SELECT slug, name FROM leads WHERE stripe_customer = ?").bind(o.customer).first();
    if (lead) {
      await env.DB.batch([
        env.DB.prepare("UPDATE leads SET status = 'churned' WHERE slug = ?").bind(lead.slug),
        env.DB.prepare("INSERT INTO events (slug, type, at, meta) VALUES (?, 'churn', ?, '{}')").bind(lead.slug, now),
      ]);
      notify(env, ctx, { title: `📉 ${lead.name} a résilié`, message: "Site suspendu. Un appel peut le sauver.", priority: 4 });
    }
    return json({ ok: true });
  }

  if (evt.type === "invoice.payment_failed" && o.customer) {
    const lead = await env.DB.prepare("SELECT name FROM leads WHERE stripe_customer = ?").bind(o.customer).first();
    notify(env, ctx, { title: `⚠️ Paiement échoué${lead ? ` : ${lead.name}` : ""}`, message: "Stripe va réessayer. Un message au client aide.", priority: 4 });
  }
  return json({ ok: true });
}

export async function thankYou(env, url) {
  const sid = url.searchParams.get("session_id") || "";
  if (!sid) return null;
  return env.DB.prepare(
    "SELECT l.* FROM events e JOIN leads l ON l.slug = e.slug WHERE e.type = 'paid' AND json_extract(e.meta, '$.session') = ? LIMIT 1"
  ).bind(sid).first();
}
