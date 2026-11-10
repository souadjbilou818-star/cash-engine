// The AI closer: answers the owner's questions on the demo page and in email replies.
// It only knows the facts you configure. It says it's an AI (EU AI Act art. 50, in force since 2 Aug 2026).
import { arrondissement, frDate, checkoutUrl } from "./render.js";
export { checkoutUrl };

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export function offerFacts(env) {
  const lines = [
    `Prix : ${env.OFFER_PRICE || "390 €"} pour la mise en ligne, puis ${env.OFFER_MONTHLY || "19 €/mois"}, sans engagement (résiliable à tout moment).`,
    `Délai : en ligne sous ${env.OFFER_DELAY || "48 h"} après le paiement, sur une adresse à son nom.`,
    "Inclus : le site tel qu'il le voit, adapté avec ses vraies photos et ses textes ; hébergement rapide et sécurisé ; pensé pour le mobile et Google ; modifications sur simple message.",
    "Paiement : par carte, en ligne, via un lien sécurisé (Stripe), ou l'agence rappelle pour en parler.",
  ];
  if (env.OFFER_INCLUDES) lines.push(`Aussi inclus : ${env.OFFER_INCLUDES}.`);
  if (env.OFFER_GUARANTEE) lines.push(`Garantie : ${env.OFFER_GUARANTEE}.`);
  return lines.join("\n");
}

export function closerSystem(lead, env, channel /* chat | email */) {
  const arr = arrondissement(lead.postcode);
  const person = env.AGENCY_PERSON || "l'équipe";
  return `Tu es l'assistant IA de ${env.AGENCY_NAME || "l'agence"}, une petite agence web parisienne tenue par ${person}.
Tu échanges ${channel === "email" ? "par email" : "dans une fenêtre de discussion"} avec le ou la gérant(e) de « ${lead.name} » (${lead.category || "commerce"}${arr ? `, Paris ${arr}` : ""}), qui a reçu une maquette gratuite de son futur site.

FAITS (les seuls que tu connais) :
${offerFacts(env)}
La maquette expire${lead.expires_at ? ` le ${frDate(lead.expires_at)}` : " 14 jours après le premier contact"}.
${env.OFFER_CONCESSION ? `Geste possible UNIQUEMENT si la personne hésite à cause du prix, une seule fois : ${env.OFFER_CONCESSION}.` : "Aucune remise n'est possible."}

TON BUT : que la personne réserve en ligne, ou laisse son numéro pour que ${person} la rappelle.
MÉTHODE : 1) reconnais sa question ou son objection en quelques mots, 2) réponds avec un FAIT ci-dessus, 3) termine par UNE question fermée qui mène à l'étape suivante (« Je vous envoie le lien de réservation ? », « ${person} peut vous rappeler à quel numéro ? »).
OBJECTIONS FRÉQUENTES :
- « J'ai déjà Instagram / Planity / Uber Eats » : le site ne remplace rien, il rassemble tout et permet d'être trouvé sur Google en dehors de ces plateformes.
- « C'est cher » : rappelle que c'est sans engagement et que la maquette est déjà faite ; propose le geste seulement s'il existe.
- « Je vais réfléchir » : respecte, rappelle la date d'expiration, propose un rappel à une date précise.
- « Ça marche comment ? » : réservation en ligne, puis ${person} récupère photos et textes, site en ligne sous ${env.OFFER_DELAY || "48 h"}.
INTERDIT : inventer des chiffres (visites, clients, classement Google), des fonctionnalités, des délais ou des remises ; promettre la première place sur Google ; insister après un refus clair ; prétendre être humain.
Si la personne n'est pas intéressée : remercie poliment, dis-lui qu'elle ne sera plus contactée si elle le souhaite, et arrête.
Si tu ne sais pas : dis que ${person} répondra directement et demande le meilleur numéro pour rappeler.
STYLE : vouvoiement, français simple, ${channel === "email" ? "5 phrases maximum, sans formule de politesse finale ni signature (elle est ajoutée automatiquement)" : "1 à 3 phrases courtes"}, pas de listes, au plus un emoji.`;
}

export async function askAI(env, system, messages, maxTokens = 260) {
  if (!env.AI || typeof env.AI.run !== "function") return null;
  try {
    const r = await env.AI.run(env.AI_MODEL || MODEL, {
      messages: [{ role: "system", content: system }, ...messages],
      max_tokens: maxTokens,
      temperature: 0.5,
    });
    const text = (r && (r.response ?? r.result?.response ?? r.choices?.[0]?.message?.content)) || "";
    const clean = String(text).replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    return clean || null;
  } catch (e) {
    console.error("AI error", e && e.message);
    return null;
  }
}

// Used when the AI is down or over its free daily allowance.
export function scripted(q, lead, env) {
  const t = q.toLowerCase();
  const person = env.AGENCY_PERSON || "Nous";
  const ask = ` Je vous envoie le lien de réservation, ou ${person} vous rappelle ?`;
  if (/prix|cher|combien|co[uû]t|tarif|€|euro/.test(t))
    return `C'est ${env.OFFER_PRICE || "390 €"} pour la mise en ligne, puis ${env.OFFER_MONTHLY || "19 €/mois"}, sans engagement.` + ask;
  if (/modif|chang|photo|texte|couleur|menu/.test(t))
    return `Oui, tout s'adapte : vos photos, vos textes, vos couleurs, et ensuite les modifications se font sur simple message.` + ask;
  if (/domaine|adresse|\.fr|\.com|url/.test(t))
    return `Le site est mis en ligne sur une adresse à votre nom, sous ${env.OFFER_DELAY || "48 h"}.` + ask;
  if (/d[ée]lai|quand|combien de temps|rapide/.test(t))
    return `Il est en ligne sous ${env.OFFER_DELAY || "48 h"} après la réservation.` + ask;
  if (/humain|personne|appel|rappel|t[ée]l[ée]phone|num[ée]ro/.test(t))
    return `Bien sûr. Laissez votre numéro ici et ${person} vous rappelle rapidement.`;
  if (/pas int[ée]ress|non merci|stop|arr[eê]t/.test(t))
    return `Pas de souci, merci d'avoir regardé. Vous pouvez cliquer sur « Ne plus être contacté » en bas de la fenêtre de réservation.`;
  return `Bonne question : ${person} vous répond directement. Laissez votre numéro ici et il vous rappelle.`;
}

export const PHONE_RE = /(?:\+33\s?|0033\s?|0)[1-9](?:[\s.\-]?\d{2}){4}/;

export async function chat(req, env, ctx, lead, deps) {
  const { json, notify, origin } = deps;
  const body = await req.json().catch(() => ({}));
  const msgs = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 800) }));
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return json({ error: "empty" }, 400);
  const q = msgs[msgs.length - 1].content;
  const row = await env.DB.prepare("UPDATE leads SET chats = chats + 1 WHERE slug = ? RETURNING chats").bind(lead.slug).first();
  const n = row ? row.chats : 1;
  const cap = parseInt(env.CHAT_CAP || "40", 10);
  const now = Date.now();
  const phone = (q.match(PHONE_RE) || [])[0];
  const actions = [{ action: "view", label: "📞 Appeler", url: `tel:${(phone || lead.phone || "").replace(/[^\d+]/g, "")}` }];

  if (phone) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO events (slug, type, at, meta) VALUES (?, 'claim', ?, ?)").bind(lead.slug, now, JSON.stringify({ phone, via: "chat", msg: q.slice(0, 300) })),
      env.DB.prepare("UPDATE leads SET status = CASE WHEN status IN ('won','churned') THEN status ELSE 'hot' END, notes = TRIM(COALESCE(notes,'') || ' | chat: ' || ?) WHERE slug = ?").bind(`${phone} ${q.slice(0, 120)}`, lead.slug),
    ]);
    notify(env, ctx, { title: `💸 ${lead.name} veut être rappelé`, message: `${phone}\n« ${q.slice(0, 200)} »`, priority: 5, click: `${origin}/admin?status=hot`, actions });
    return json({ reply: `Merci ! ${env.AGENCY_PERSON || "Nous"} vous rappelle au ${phone} très vite. En attendant, vous pouvez aussi réserver directement.`, captured: true });
  }
  if (n === 1) notify(env, ctx, { title: `💬 ${lead.name} pose une question`, message: `« ${q.slice(0, 200)} »\nL'assistant IA répond. Tél : ${lead.phone || "?"}`, priority: 4, click: `${origin}/admin?status=opened`, actions });

  let reply = null;
  if (n <= cap) reply = await askAI(env, closerSystem(lead, env, "chat"), msgs);
  if (!reply) reply = scripted(q, lead, env);
  reply = reply.slice(0, 700);
  await env.DB.prepare("INSERT INTO events (slug, type, at, meta) VALUES (?, 'chat', ?, ?)").bind(lead.slug, now, JSON.stringify({ q: q.slice(0, 500), a: reply })).run();
  return json({ reply });
}
