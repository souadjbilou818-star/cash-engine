// Runs the real Worker code in Node against an in-memory SQLite "D1".
// node --no-warnings tests/test_worker.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";
import worker from "../worker/src/index.js";

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
  async batch(s) { const out = []; for (const x of s) out.push(await x.run()); return out; }
}

const db = new D1();
db.db.exec(readFileSync(new URL("../worker/schema.sql", import.meta.url), "utf8"));
const env = {
  DB: db, ADMIN_KEY: "test-admin-key", NTFY_TOPIC: "secret-topic", AGENCY_NAME: "Studio Rive", AGENCY_PERSON: "Sami",
  AGENCY_PHONE: "06 00 00 00 00", OFFER_PRICE: "390 €", OFFER_MONTHLY: "19 €/mois", OFFER_DELAY: "48 h", DEMO_DAYS: "14",
  CHECKOUT_URL: "https://buy.stripe.com/test_123",
};
const pings = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { if (String(url).startsWith("https://ntfy.sh")) { pings.push(JSON.parse(init.body)); return new Response("ok"); } return realFetch(url, init); };
const ctx = { waitUntil: (p) => p };
const B = "https://cash-engine.demo.workers.dev";
const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const call = (path, init = {}) => worker.fetch(new Request(B + path, { redirect: "manual", ...init, headers: { "user-agent": PHONE_UA, ...(init.headers || {}) } }), env, ctx);
const auth = { authorization: "Bearer test-admin-key", "content-type": "application/json" };
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log("✓", m); };

// push leads from the pipeline's dry run
const leads = JSON.parse(readFileSync(new URL("../data/preview.json", import.meta.url), "utf8"));
ok((await call("/api/leads", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status === 401, "API rejects missing key");
let r = await call("/api/leads", { method: "POST", headers: auth, body: JSON.stringify({ leads }) });
ok(r.status === 200 && (await r.json()).received === leads.length, "pipeline push accepted");
r = await call("/api/leads", { method: "POST", headers: auth, body: JSON.stringify({ leads }) });
ok((await db.prepare("SELECT COUNT(*) n FROM leads").first()).n === leads.length, "re-push is idempotent (dedupe on osm_id)");
const known = await (await call("/api/known", { headers: auth })).json();
ok(known.osm_ids.length === leads.length, "/api/known returns dedupe keys");

mkdirSync(new URL("../data/render/", import.meta.url), { recursive: true });
const nadia = leads.find((l) => l.name === "Chez Nadia");
const barber = leads.find((l) => l.theme === "barber");

// demo page
r = await call(`/s/${nadia.slug}`);
let page = await r.text();
ok(r.status === 200 && page.includes("Maquette pour Chez Nadia") && page.includes("noindex"), "demo renders with banner + noindex");
ok(page.includes("Mardi") && page.includes("12h–14h30 · 19h–22h30") && page.includes("Fermé"), "OSM opening hours rendered in French");
ok(page.includes("/c/" + nadia.slug) && page.includes("buy.stripe.com"), "claim sheet + checkout link present");
writeFileSync(new URL(`../data/render/demo-food.html`, import.meta.url), page);
writeFileSync(new URL(`../data/render/demo-barber.html`, import.meta.url), await (await call(`/s/${barber.slug}`)).text());
for (const t of ["beauty", "retail", "dark"]) { const l = leads.find((x) => x.theme === t); if (l) writeFileSync(new URL(`../data/render/demo-${t}.html`, import.meta.url), await (await call(`/s/${l.slug}`)).text()); }
ok((await call(`/s/nope-0000`)).status === 404, "unknown slug -> 404");

// bots never trigger alerts
await call(`/e/${nadia.slug}`, { method: "POST", body: '{"t":"view"}', headers: { "user-agent": "WhatsApp/2.23.20 A" } });
await call(`/e/${nadia.slug}`, { method: "POST", body: '{"t":"view"}', headers: { "user-agent": "facebookexternalhit/1.1" } });
ok(pings.length === 0, "link-preview bots ignored");

// real opens
await call(`/e/${nadia.slug}`, { method: "POST", body: '{"t":"view"}' });
ok(pings.length === 1 && pings[0].title.includes("Chez Nadia ouvre sa démo") && pings[0].actions[0].url === "tel:+33612345678", "first real open -> push with tap-to-call");
let row = await db.prepare("SELECT status, views FROM leads WHERE slug=?").bind(nadia.slug).first();
ok(row.status === "opened" && row.views === 1, "status -> opened");
await call(`/e/${nadia.slug}`, { method: "POST", body: '{"t":"view"}' });
await call(`/e/${nadia.slug}`, { method: "POST", body: '{"t":"view"}' });
ok(pings.length === 2 && pings[1].title.includes("3e visite") && pings[1].priority === 5, "3rd visit -> urgent push");
await call(`/e/${nadia.slug}`, { method: "POST", body: '{"t":"cta_claim"}' });
ok(pings.at(-1).title.includes("regarde le prix"), "price sheet opened -> push");

// claim
const fd = new URLSearchParams({ who: "Nadia", phone: "06 12 34 56 78", msg: "Ajouter le menu" });
r = await call(`/c/${nadia.slug}`, { method: "POST", body: fd, headers: { "content-type": "application/x-www-form-urlencoded" } });
ok(r.status === 200 && (await r.text()).includes("Réserver maintenant"), "claim -> thank you + checkout");
ok(pings.at(-1).title.includes("VEUT LE SITE"), "claim -> money push");
row = await db.prepare("SELECT status, notes FROM leads WHERE slug=?").bind(nadia.slug).first();
ok(row.status === "hot" && row.notes.includes("Ajouter le menu"), "lead -> hot with the request noted");

// admin
ok((await call("/admin")).status === 401, "admin locked without key");
r = await call("/admin?k=test-admin-key");
const cookie = r.headers.get("set-cookie").split(";")[0];
ok(r.status === 302 && cookie.startsWith("ce="), "admin key sets cookie");
r = await call("/admin", { headers: { cookie } });
page = await r.text();
ok(page.includes("wa.me/33612345678?text=") && page.includes("sms:+33612345678"), "hit list: WhatsApp/SMS prefilled for mobiles");
ok(!page.includes("wa.me/33143001122"), "no WhatsApp button for landlines");
ok(page.includes("mailto:contact%40onglesdor-paris.fr") || page.includes("mailto:contact@onglesdor-paris.fr"), "hit list: email prefilled");
ok(!page.includes("{expiry}") && !page.includes("{url}"), "placeholders filled in hit list");
writeFileSync(new URL(`../data/render/admin.html`, import.meta.url), page);

// own views don't count
const before = pings.length;
await call(`/e/${barber.slug}`, { method: "POST", body: '{"t":"view"}', headers: { cookie } });
ok(pings.length === before, "your own views (admin cookie) don't trigger alerts");

// contacted -> countdown starts
r = await call("/admin/status", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ slug: barber.slug, status: "contacted", soft: true }) });
row = await db.prepare("SELECT status, expires_at FROM leads WHERE slug=?").bind(barber.slug).first();
ok(row.status === "contacted" && row.expires_at > Date.now() + 13 * 86400000, "contacted -> 14-day expiry set");

// outbox for the email sender
const box = await (await call("/api/outbox", { headers: auth })).json();
ok(box.items.length >= 1 && box.items.every((l) => l.email && l.which === "initial"), "outbox lists uncontacted leads with published email");

// opt-out
const ongles = leads.find((l) => l.email);
r = await call(`/stop/${ongles.slug}`, { method: "POST" });
ok(r.status === 200, "opt-out works");
ok((await call(`/s/${ongles.slug}`)).status === 404, "opted-out demo is taken down");
const box2 = await (await call("/api/outbox", { headers: auth })).json();
ok(!box2.items.some((l) => l.slug === ongles.slug), "opted-out lead never emailed again");
const sup = await (await call("/api/known", { headers: auth })).json();
ok(sup.suppress.includes("contact@onglesdor-paris.fr") && sup.suppress.includes("33143001122"), "suppression list has email + phone");

// expiry
await db.prepare("UPDATE leads SET expires_at=? WHERE slug=?").bind(Date.now() - 1000, barber.slug).run();
ok((await call(`/s/${barber.slug}`)).status === 410, "expired demo -> 410 'réactivable' page");

// won -> live on client domain
const fd2 = new URLSearchParams({ name: nadia.name, phone: "06 12 34 56 78", hours: nadia.hours, domain: "https://www.cheznadia.fr/", status: "won", notes: "payé", content: JSON.stringify(nadia.content) });
r = await call(`/admin/edit/${nadia.slug}`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: fd2 });
ok(r.status === 303, "edit saved");
r = await worker.fetch(new Request("https://www.cheznadia.fr/", { headers: { "user-agent": PHONE_UA } }), env, ctx);
page = await r.text();
ok(r.status === 200 && !page.includes("Maquette pour") && !page.includes("noindex") && !page.includes("/e/"), "won client served live on own domain: no banner, indexable, no tracking");
writeFileSync(new URL(`../data/render/live.html`, import.meta.url), page);
ok((await (await worker.fetch(new Request("https://cheznadia.fr/robots.txt"), env, ctx)).text()).includes("Allow"), "live robots.txt allows indexing");

const stats = await (await call("/api/stats", { headers: auth })).json();
ok(stats.by_status.length > 0, "stats endpoint");
console.log(`\n${n} checks passed`);
