// AI inbox: prospects' email replies land here (Cloudflare Email Routing -> this Worker).
// STOP / not interested  -> blacklisted instantly, no reply.
// out-of-office          -> ignored.
// interested / question  -> lead goes hot, you get a push, and (AUTO_REPLY=1) the AI closer answers in the thread.
// Every message is also forwarded to your real inbox (FORWARD_TO).
import { askAI, closerSystem, checkoutUrl } from "./closer.js";
import { waNumber } from "./render.js";

// ---------- minimal MIME parsing (text/plain first, html fallback) ----------
function splitHeaders(raw) {
  const i = raw.search(/\r?\n\r?\n/);
  const head = i < 0 ? raw : raw.slice(0, i);
  const body = i < 0 ? "" : raw.slice(i).replace(/^\r?\n\r?\n/, "");
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) headers[m[1].toLowerCase()] = m[2];
  }
  return { headers, body };
}

function decodeBytes(bytes, charset) {
  try { return new TextDecoder(charset || "utf-8").decode(bytes); }
  catch { return new TextDecoder("utf-8").decode(bytes); }
}

function decodeBody(body, enc, charset) {
  enc = (enc || "").toLowerCase();
  if (enc === "base64") {
    const bin = atob(body.replace(/[^A-Za-z0-9+/=]/g, ""));
    return decodeBytes(Uint8Array.from(bin, (c) => c.charCodeAt(0)), charset);
  }
  if (enc === "quoted-printable") {
    const s = body.replace(/=\r?\n/g, "");
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "=" && /^[0-9A-F]{2}$/i.test(s.slice(i + 1, i + 3))) { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
      else bytes.push(s.charCodeAt(i) & 0xff);
    }
    return decodeBytes(new Uint8Array(bytes), charset);
  }
  return body;
}

export function decodeWords(s) {
  return String(s || "").replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, cs, e, txt) =>
    e.toUpperCase() === "B" ? decodeBody(txt, "base64", cs) : decodeBody(txt.replace(/_/g, " "), "quoted-printable", cs)
  ).replace(/\?=\s+=\?/g, "");
}

function findText(raw, depth = 0) {
  const { headers, body } = splitHeaders(raw);
  const ct = headers["content-type"] || "text/plain";
  const charset = (ct.match(/charset="?([\w-]+)/i) || [])[1];
  if (/multipart\//i.test(ct) && depth < 5) {
    const b = (ct.match(/boundary="?([^";]+)"?/i) || [])[1];
    if (!b) return { text: "", html: "" };
    const parts = body.split("--" + b).slice(1).filter((p) => !p.startsWith("--"));
    let html = "";
    for (const p of parts) {
      const r = findText(p.replace(/^\r?\n/, ""), depth + 1);
      if (r.text) return r;
      if (r.html && !html) html = r.html;
    }
    return { text: "", html };
  }
  const decoded = decodeBody(body, headers["content-transfer-encoding"], charset);
  if (/text\/html/i.test(ct)) return { text: "", html: decoded };
  if (/text\/plain/i.test(ct)) return { text: decoded, html: "" };
  return { text: "", html: "" };
}

export function parseMime(raw) {
  const { headers } = splitHeaders(raw);
  let { text, html } = findText(raw);
  if (!text && html) text = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ");
  return {
    subject: decodeWords(headers["subject"]),
    messageId: headers["message-id"] || "",
    references: headers["references"] || "",
    autoSubmitted: headers["auto-submitted"] || "",
    precedence: headers["precedence"] || "",
    text: (text || "").trim(),
  };
}

// Drop the quoted thread so we only read what they wrote.
export function stripQuoted(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) break;
    if (/^\s*(le .{3,120} a écrit\s*:|on .{3,120} wrote\s*:|-{2,}\s*(original message|message d'origine)|de\s*:\s.+@|from\s*:\s.+@|envoyé de mon)/i.test(l)) break;
    out.push(l);
  }
  return out.join("\n").trim();
}

// ---------- intent ----------
const RULES = [
  ["stop", /\b(stop|d[ée]sinscri|d[ée]sabonn|ne (plus|pas) me (contacter|[ée]crire)|retirez|supprimez mes|rgpd)\b/i],
  ["not_interested", /(pas int[ée]ress|non merci|ça ne m'int[ée]resse|pas besoin|d[ée]j[aà] un site|on a d[ée]j[aà]|pas pour le moment|^\s*non\b)/i],
  ["callback", /(rappel|appelez|appeler|t[ée]l[ée]phone|mon num[ée]ro|joignable)/i],
  ["interested", /(^\s*oui\b|int[ée]ress|ok pour|d'accord|go\b|je (la|le) veux|on y va|ça me pla[iî]t|tr[eè]s bien|super)/i],
  ["question", /\?/],
];

export function ruleIntent(text, meta = {}) {
  if (/auto-replied|auto-generated/i.test(meta.autoSubmitted || "") || /bulk|auto_reply|junk/i.test(meta.precedence || "") ||
      /(absent|absence|out of office|r[ée]ponse automatique|automatic reply|en cong[ée]s)/i.test(`${meta.subject || ""} ${text.slice(0, 300)}`))
    return "auto";
  for (const [k, re] of RULES) if (re.test(text)) return k;
  return "other";
}

async function aiIntent(env, text) {
  const r = await askAI(env,
    "Classe la réponse d'un commerçant à une proposition de site web. Réponds par UN seul mot parmi : interested, question, callback, not_interested, stop, auto, other.",
    [{ role: "user", content: text.slice(0, 1500) }], 5);
  const m = (r || "").toLowerCase().match(/interested|question|callback|not_interested|stop|auto|other/);
  return m ? m[0] : null;
}

// ---------- outgoing MIME ----------
const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

export function buildReply({ fromName, fromAddr, to, subject, inReplyTo, references, text, domain }) {
  const id = `<${crypto.randomUUID()}@${domain}>`;
  const body = b64(text).replace(/.{1,76}/g, "$&\r\n");
  const subj = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  const refs = [references, inReplyTo].filter(Boolean).join(" ").trim();
  return {
    id,
    raw: [
      `From: ${encWord(fromName)} <${fromAddr}>`,
      `To: <${to}>`,
      `Subject: ${encWord(subj)}`,
      `Message-ID: ${id}`,
      inReplyTo ? `In-Reply-To: ${inReplyTo}` : "",
      refs ? `References: ${refs}` : "",
      `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      body,
    ].filter((l, i, a) => l !== "" || i === a.length - 2).join("\r\n"),
  };
}

// ---------- handler ----------
export async function handleEmail(message, env, ctx, EmailMessage, deps) {
  const { notify } = deps;
  const origin = String(env.PUBLIC_URL || "").replace(/\/$/, "");
  const raw = await new Response(message.raw).text();
  const mail = parseMime(raw);
  const from = String(message.from || "").toLowerCase();
  const to = String(message.to || "").toLowerCase();

  if (env.FORWARD_TO) {
    try { await message.forward(env.FORWARD_TO); } catch (e) { console.error("forward failed", e && e.message); }
  }

  const slug = (to.match(/^[^+@]+\+([a-z0-9-]{3,80})@/) || [])[1];
  let lead = slug ? await env.DB.prepare("SELECT * FROM leads WHERE slug = ?").bind(slug).first() : null;
  if (!lead) lead = await env.DB.prepare("SELECT * FROM leads WHERE lower(email) = ? ORDER BY created_at DESC LIMIT 1").bind(from).first();
  if (!lead) {
    notify(env, ctx, { title: "📩 Email reçu (lead inconnu)", message: `${from}\n${mail.subject}\n${mail.text.slice(0, 200)}`, priority: 3 });
    return { intent: "unknown" };
  }

  const said = stripQuoted(mail.text).slice(0, 3000) || mail.text.slice(0, 500);
  let intent = ruleIntent(said, mail);
  if (intent === "other" || intent === "question") intent = (await aiIntent(env, said)) || intent;
  const now = Date.now();
  await env.DB.prepare("INSERT INTO events (slug, type, at, meta) VALUES (?, 'email_in', ?, ?)")
    .bind(lead.slug, now, JSON.stringify({ from, subject: mail.subject, text: said.slice(0, 1500), intent })).run();

  if (intent === "auto") return { intent };
  if (intent === "stop" || intent === "not_interested") {
    const keys = [lead.phone && waNumber(lead.phone), lead.email && String(lead.email).toLowerCase(), from].filter(Boolean);
    await env.DB.batch([
      ...[...new Set(keys)].map((k) => env.DB.prepare("INSERT OR IGNORE INTO suppress (key, at) VALUES (?, ?)").bind(k, now)),
      env.DB.prepare("UPDATE leads SET status = 'optout' WHERE slug = ? AND status NOT IN ('won','churned')").bind(lead.slug),
    ]);
    notify(env, ctx, { title: `🚫 ${lead.name} : ${intent === "stop" ? "STOP" : "pas intéressé"}`, message: said.slice(0, 200), priority: 2 });
    return { intent };
  }

  await env.DB.prepare(
    "UPDATE leads SET status = CASE WHEN status IN ('won','churned','optout') THEN status WHEN ? THEN 'hot' ELSE CASE WHEN status IN ('new','contacted') THEN 'opened' ELSE status END END WHERE slug = ?"
  ).bind(intent === "interested" || intent === "callback" ? 1 : 0, lead.slug).run();

  let replied = false, draft = null;
  if (["interested", "question", "callback"].includes(intent) && env.REPLY_DOMAIN) {
    const pay = checkoutUrl(env, lead.slug);
    const context = `${said}\n\n[Lien de réservation à donner si la personne est prête : ${pay || "aucun, propose un rappel"}]\n[Lien de la maquette : ${origin}/s/${lead.slug}]`;
    draft = await askAI(env, closerSystem(lead, env, "email"), [{ role: "user", content: context }], 350);
    if (draft && env.AUTO_REPLY === "1") {
      const person = env.AGENCY_PERSON || "L'équipe";
      const text = `${draft}\n\n${person}\n${env.AGENCY_NAME || ""} · ${env.AGENCY_PHONE || ""}\n\n—\nRéponse rédigée par l'assistant IA de ${env.AGENCY_NAME || "l'agence"}. ${person} lit cette conversation et peut vous rappeler.\nNe plus être contacté : ${origin}/stop/${lead.slug}`;
      const fromAddr = `${(env.AGENCY_PERSON || "contact").split(" ")[0].toLowerCase().normalize("NFD").replace(/[^a-z]/g, "") || "contact"}@${env.REPLY_DOMAIN}`;
      const out = buildReply({ fromName: person, fromAddr, to: message.from, subject: mail.subject || lead.name, inReplyTo: mail.messageId, references: mail.references, text, domain: env.REPLY_DOMAIN });
      try {
        await message.reply(new EmailMessage(fromAddr, message.from, out.raw));
        replied = true;
        await env.DB.prepare("INSERT INTO events (slug, type, at, meta) VALUES (?, 'email_out', ?, ?)").bind(lead.slug, Date.now(), JSON.stringify({ text: draft })).run();
      } catch (e) {
        console.error("reply failed", e && e.message); // e.g. sender without valid DMARC: you'll answer by hand
      }
    }
  }
  const icon = intent === "interested" ? "💸" : intent === "callback" ? "📞" : "📩";
  notify(env, ctx, {
    title: `${icon} ${lead.name} a répondu (${intent})`,
    message: `« ${said.slice(0, 180)} »\n${replied ? "✅ L'IA a répondu dans le fil." : draft ? "✍️ Brouillon prêt dans la hit list." : "À toi de répondre."}`,
    priority: intent === "question" ? 4 : 5,
    click: `${origin}/admin?status=hot`,
    actions: lead.phone ? [{ action: "view", label: "📞 Appeler", url: `tel:${String(lead.phone).replace(/[^\d+]/g, "")}` }] : undefined,
  });
  if (draft && !replied) {
    await env.DB.prepare("INSERT INTO events (slug, type, at, meta) VALUES (?, 'draft', ?, ?)").bind(lead.slug, Date.now(), JSON.stringify({ text: draft, to: from, subject: mail.subject })).run();
  }
  return { intent, replied };
}
