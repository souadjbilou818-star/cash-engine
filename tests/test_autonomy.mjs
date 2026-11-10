// Autonomy tests: AI closer chat, email sequence, AI inbox, Stripe -> instant delivery, churn, digest.
// node --no-warnings tests/test_autonomy.mjs   (run the pipeline fixture first: see README)
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import worker, { notify, digest } from "../worker/src/index.js";
import { handleEmail, parseMime, stripQuoted } from "../worker/src/inbox.js";

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...a) { return new Stmt(this.db, this.sql, a.map((x) => (x === undefined ? null : x))); }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async run() { this.db.prepare(this.sql).run(...this.args); return { success: true }; }
}
class D1 {
  constructor() { this.db = new DatabaseSync(":memory:"); }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(s) { for (const x of s) await x.run(); }
}
const db = new D1();
db.db.exec(readFileSync(new URL("../worker/schema.sql", import.meta.url), "utf8"));

const aiLog = [];
let aiDown = false;
const env = {
  DB: db, ADMIN_KEY: "k", NTFY_TOPIC: "t", AGENCY_NAME: "Studio Rive", AGENCY_PERSON: "Sami", AGENCY_PHONE: "06 00 00 00 00",
  OFFER_PRICE: "390 €", OFFER_MONTHLY: "19 €/mois", OFFER_DELAY: "48 h", DEMO_DAYS: "14", PUBLIC_URL: "https://demo.studiorive.fr",
  DEMO_HOST: "demo.studiorive.fr", CHECKOUT_URL: "https://buy.stripe.com/test_abc", CLIENT_ZONE: "studiorive.fr", REPLY_DOMAIN: "studiorive.fr",
  AUTO_REPLY: "1", FORWARD_TO: "sami@proton.me", STRIPE_WEBHOOK_SECRET: "whsec_test", CHAT_CAP: "40",
  AI: {
    run: async (model, { messages, max_tokens }) => {
      aiLog.push({ model, messages });
      if (aiDown) throw new Error("daily allowance exceeded");
      const last = messages[messages.length - 1].content;
      if (max_tokens === 5) return { response: /oui|int[ée]ress/i.test(last) ? "interested" : "question" };
      return { response: "C'est 390 € puis 19 €/mois, sans engagement, et vos photos remplacent celles de la maquette. Je vous envoie le lien de réservation ?" };
    },
  },
};
const pings = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => (String(url).startsWith("https://ntfy.sh") ? (pings.push(JSON.parse(init.body)), new Response("ok")) : realFetch(url, init));
const ctx = { waitUntil: (p) => p };
const B = "https://demo.studiorive.fr";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1";
const call = (path, init = {}, base = B) => worker.fetch(new Request(base + path, { redirect: "manual", ...init, headers: { "user-agent": UA, ...(init.headers || {}) } }), env, ctx);
const auth = { authorization: "Bearer k", "content-type": "application/json" };
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log("✓", m); };
const lead = (slug) => db.prepare("SELECT * FROM leads WHERE slug = ?").bind(slug).first();

// seed: pipeline output + one lead with a published email for the sequence
const leads = JSON.parse(readFileSync(new URL("../data/preview.json", import.meta.url), "utf8"));
const lea = leads.find((l) => l.name === "Le Comptoir de Léa");
const mail = { ...lea, slug: "le-comptoir-de-lea-mail-1a2b", osm_id: "test/mail", email: "lea@comptoirdelea.fr", phone: "06 11 22 33 44" };
await call("/api/leads", { method: "POST", headers: auth, body: JSON.stringify({ leads: [...leads, mail] }) });

// ---------- AI closer chat ----------
let page = await (await call(`/s/${lea.slug}`)).text();
ok(page.includes("assistant <b>IA</b>") && page.includes("/chat/"), "demo has the AI closer, disclosed as AI from the first message");
ok(page.includes(`client_reference_id=${lea.slug}`), "every Réserver button carries the lead id to Stripe");
let r = await call(`/chat/${lea.slug}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "Combien ça coûte ?" }] }) });
let j = await r.json();
ok(j.reply.includes("390 €") && pings.at(-1).title.includes("pose une question"), "closer answers with configured facts + you get a push");
ok(aiLog.at(-1).messages[0].content.includes("INTERDIT") && aiLog.at(-1).messages[0].content.includes("390 €"), "system prompt carries offer facts + guardrails");
aiDown = true;
j = await (await call(`/chat/${lea.slug}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "je peux modifier les photos ?" }] }) })).json();
ok(j.reply.startsWith("Oui, tout s'adapte"), "AI down/over quota -> scripted answer, never silent");
aiDown = false;
j = await (await call(`/chat/${lea.slug}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "Rappelez moi au 06 98 76 54 32 svp" }] }) })).json();
ok(j.captured && (await lead(lea.slug)).status === "hot" && pings.at(-1).title.includes("veut être rappelé") && pings.at(-1).priority === 5, "phone typed in chat -> lead hot + urgent push");

// ---------- email sequence ----------
let box = await (await call("/api/outbox", { headers: auth })).json();
let it = box.items.find((x) => x.slug === mail.slug);
ok(it && it.which === "initial", "outbox: first email due");
await call("/api/emailed", { method: "POST", headers: auth, body: JSON.stringify({ items: [{ slug: mail.slug, which: "initial", msgid: "<first@studiorive.fr>" }] }) });
let L = await lead(mail.slug);
ok(L.status === "contacted" && L.email_step === 1 && L.email_msgid === "<first@studiorive.fr>" && L.expires_at > Date.now(), "sent -> contacted, countdown started, thread id stored");
box = await (await call("/api/outbox", { headers: auth })).json();
ok(!box.items.some((x) => x.slug === mail.slug), "no follow-up before 3 days");
await db.prepare("UPDATE leads SET last_email_at = ? WHERE slug = ?").bind(Date.now() - 4 * 86400000, mail.slug).run();
it = (await (await call("/api/outbox", { headers: auth })).json()).items.find((x) => x.slug === mail.slug);
ok(it && it.which === "bump" && it.msgid === "<first@studiorive.fr>", "day 3+, not opened -> bump, threaded");
await db.prepare("UPDATE leads SET status = 'opened' WHERE slug = ?").bind(mail.slug).run();
it = (await (await call("/api/outbox", { headers: auth })).json()).items.find((x) => x.slug === mail.slug);
ok(it && it.which === "opened", "opened the demo but silent -> 'opened' nudge instead");
await call("/api/emailed", { method: "POST", headers: auth, body: JSON.stringify({ items: [{ slug: mail.slug, which: "opened" }] }) });
await db.prepare("UPDATE leads SET last_email_at = ? WHERE slug = ?").bind(Date.now() - 4 * 86400000, mail.slug).run();
it = (await (await call("/api/outbox", { headers: auth })).json()).items.find((x) => x.slug === mail.slug);
ok(!it, "only one 'opened' nudge per lead");

// ---------- AI inbox ----------
class FakeEmailMessage { constructor(from, to, raw) { this.from = from; this.to = to; this.raw = raw; } }
const mkMail = (from, to, raw) => { const m = { from, to, raw: new Blob([raw]).stream(), fwd: [], rep: [] }; m.forward = async (a) => m.fwd.push(a); m.reply = async (x) => m.rep.push(x); return m; };
const rawYes = [
  "From: =?UTF-8?Q?L=C3=A9a?= <lea@comptoirdelea.fr>", `To: reply+${mail.slug}@studiorive.fr`,
  "Subject: =?UTF-8?Q?Re=3A_Le_Comptoir_de_L=C3=A9a_=3A_le_site?=", "Message-ID: <abc123@mail.fr>", "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="b1"', "", "--b1", 'Content-Type: text/plain; charset="utf-8"', "Content-Transfer-Encoding: quoted-printable", "",
  "Bonjour, oui =C3=A7a m'int=C3=A9resse ! Je peux changer les photos ?", "", "Le lun. 9 nov. 2026 =C3=A0 10:00, Sami <sami@gmail.com> a =C3=A9crit :", "> Bonjour, je suis Sami...",
  "--b1", 'Content-Type: text/html; charset="utf-8"', "", "<p>Bonjour, oui</p>", "--b1--", "",
].join("\r\n");
const parsed = parseMime(rawYes);
ok(parsed.subject === "Re: Le Comptoir de Léa : le site" && stripQuoted(parsed.text) === "Bonjour, oui ça m'intéresse ! Je peux changer les photos ?", "MIME decoded (QP, UTF-8 subject), quoted thread stripped");
let m1 = mkMail("lea@comptoirdelea.fr", `reply+${mail.slug}@studiorive.fr`, rawYes);
let res = await handleEmail(m1, env, ctx, FakeEmailMessage, { notify });
ok(res.intent === "interested" && res.replied, "interested reply -> classified, AI answered in the thread");
const out = m1.rep[0];
const outRaw = out.raw;
const outBody = Buffer.from(outRaw.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8");
ok(out.from === "sami@studiorive.fr" && out.to === "lea@comptoirdelea.fr" && outRaw.includes("In-Reply-To: <abc123@mail.fr>"), "reply threaded, sent from your domain");
ok(outBody.includes("assistant IA") && outBody.includes(`/stop/${mail.slug}`), "reply discloses AI + opt-out link");
ok(m1.fwd[0] === "sami@proton.me" && (await lead(mail.slug)).status === "hot" && pings.at(-1).title.includes("a répondu (interested)"), "copy forwarded to you, lead hot, push sent");
const rawStop = ["From: x@boulangerie.fr", `To: reply+${leads[0].slug}@studiorive.fr`, "Subject: Re: maquette", "Message-ID: <s@x>", "Content-Type: text/plain; charset=utf-8", "", "STOP merci", ""].join("\r\n");
let m2 = mkMail("x@boulangerie.fr", `reply+${leads[0].slug}@studiorive.fr`, rawStop);
res = await handleEmail(m2, env, ctx, FakeEmailMessage, { notify });
const sup = await db.prepare("SELECT key FROM suppress WHERE key = 'x@boulangerie.fr'").first();
ok(res.intent === "stop" && !m2.rep.length && sup && (await lead(leads[0].slug)).status === "optout", "STOP -> blacklisted instantly, no reply");
const rawOoo = ["From: y@z.fr", `To: reply+${leads[1].slug}@studiorive.fr`, "Subject: Réponse automatique : absent", "Auto-Submitted: auto-replied", "Content-Type: text/plain", "", "Je suis absent jusqu'au 20.", ""].join("\r\n");
res = await handleEmail(mkMail("y@z.fr", `reply+${leads[1].slug}@studiorive.fr`, rawOoo), env, ctx, FakeEmailMessage, { notify });
ok(res.intent === "auto", "out-of-office ignored");

// ---------- Stripe -> instant delivery ----------
const sign = (body, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac("sha256", "whsec_test").update(`${t}.${body}`).digest("hex")}`;
const paid = JSON.stringify({ type: "checkout.session.completed", data: { object: { id: "cs_test_1", client_reference_id: lea.slug, amount_total: 39000, currency: "eur", customer: "cus_1", customer_details: { email: "lea@x.fr" } } } });
r = await call("/stripe/webhook", { method: "POST", headers: { "stripe-signature": "t=1,v1=bad" }, body: paid });
ok(r.status === 400, "forged webhook rejected");
r = await call("/stripe/webhook", { method: "POST", headers: { "stripe-signature": sign(paid) }, body: paid });
L = await lead(lea.slug);
ok(r.status === 200 && L.status === "won" && L.domain === "le-comptoir-de-lea.studiorive.fr" && L.stripe_customer === "cus_1", "payment -> won + subdomain assigned");
ok(pings.at(-1).title.includes("PAYÉ 390,00 EUR"), "money push");
page = await (await call("/", {}, "https://le-comptoir-de-lea.studiorive.fr")).text();
ok(page.includes("Le Comptoir de Léa") && !page.includes("Maquette pour") && !page.includes("cw-btn"), "client site live instantly: no banner, no chat");
page = await (await call("/merci?session_id=cs_test_1")).text();
ok(page.includes("le-comptoir-de-lea.studiorive.fr") && page.includes("wa.me/33600000000"), "thank-you page: live link + send photos on WhatsApp");
const del = JSON.stringify({ type: "customer.subscription.deleted", data: { object: { customer: "cus_1" } } });
await call("/stripe/webhook", { method: "POST", headers: { "stripe-signature": sign(del) }, body: del });
r = await call("/", {}, "https://le-comptoir-de-lea.studiorive.fr");
ok(r.status === 503 && (await lead(lea.slug)).status === "churned", "subscription cancelled -> site suspended");

// ---------- admin + digest ----------
r = await call("/admin?k=k");
const cookie = r.headers.get("set-cookie").split(";")[0];
page = await (await call("/admin?status=hot", { headers: { cookie } })).text();
ok(page.includes("L'IA a répondu") && page.includes("Ouvert le 2 octobre 2026"), "hit list shows AI replies and opening date");
page = await (await call("/admin?status=new", { headers: { cookie } })).text();
ok(page.includes("À faire en visite"), "walk-in script for leads with no phone/email");
const d = await digest(env, ctx);
ok(d.includes("questions") && d.includes("390 € encaissés") && pings.at(-1).title === "Bilan du jour", "evening digest pushed");

console.log(`\n${n} checks passed`);
