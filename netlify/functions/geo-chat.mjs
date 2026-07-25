// Geo, the GEO Scorecard assistant
// Serves POST /api/geo-chat for the chat widget on thearm.ai/geo pages.
// Answers questions grounded in the public rationale document, using the
// Anthropic API. Requires ANTHROPIC_API_KEY in this site's environment
// variables. Set a monthly spend limit in the Anthropic console.

const ALLOWED_ORIGINS = ["https://thearm.ai", "https://www.thearm.ai"];
const RATIONALE_URL = "https://thearm.ai/geo-rationale.md";
const MODEL = "claude-haiku-4-5-20251001";

let cache = { text: "", ts: 0 };

const PERSONA = `You are Geo, the assistant for the GEO Playbook and GEO Scorecard at thearm.ai, built by Chris Hudson. Geo is depicted as a hare: fast, agile, and direct. Lead with the answer in your very first sentence, then add only the context that earns its place. You answer questions about how the scorecard works, why each check exists, how scoring and weighting decisions were made, what results and diagnoses mean, and how to improve a score.

Rules:
- Ground every answer in the knowledge base document provided below. If the answer is not in it and is not general GEO knowledge, say you don't have that documented and point the person to chris@promisepath.ai.
- Plain language. Factual tone. No hype and no urgency. Never use em dashes.
- Keep answers short, two to six sentences, unless the person asks for depth.
- Never invent scores, statistics, or claims about specific websites.
- If asked about a specific site's result, explain what the relevant check or diagnosis means in general and how to verify by hand.
- You are not a general-purpose assistant. For unrelated topics, politely say you only cover the GEO Playbook and Scorecard.`;

async function getRationale() {
  const now = Date.now();
  if (cache.text && now - cache.ts < 10 * 60 * 1000) return cache.text;
  try {
    const r = await fetch(RATIONALE_URL, { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const t = await r.text();
      if (t && t.length > 500) { cache = { text: t, ts: now }; return t; }
    }
  } catch (e) {}
  return cache.text || "Knowledge base temporarily unavailable. Answer only from general GEO principles stated in your persona, and recommend reading thearm.ai/geo-rationale.md directly.";
}

export default async (req) => {
  const origin = req.headers.get("origin") || "";
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  const cors = {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": "application/json"
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: cors });

  const apiKey = ((typeof process !== "undefined" && process.env && process.env.ANTHROPIC_API_KEY) || "").trim();
  if (!apiKey) return new Response(JSON.stringify({ error: "Geo is not configured yet." }), { status: 200, headers: cors });

  let messages;
  try {
    const body = await req.json();
    messages = (body.messages || [])
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-8)
      .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
    if (!messages.length || messages[messages.length - 1].role !== "user") throw new Error("bad messages");
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid request." }), { status: 400, headers: cors });
  }

  const kb = await getRationale();

  // Log the question to the tracking sheet, in parallel with the model call
  const TRACK_URL = "https://script.google.com/macros/s/AKfycbzty-4Thhb6j5DtzxeXSG6G0kH99eCxsTX6a5fR-mbcwLXY2WSDlS3eX5jEX927W1he/exec";
  const lastQ = messages[messages.length - 1].content;
  const logPromise = fetch(TRACK_URL, {
    method: "POST",
    signal: AbortSignal.timeout(5000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: "geo-question", question: lastQ })
  }).catch(() => {});

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(20000),
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        system: PERSONA + "\n\n<knowledge_base>\n" + kb + "\n</knowledge_base>",
        messages
      })
    });
    const data = await r.json();
    if (!r.ok) {
      return new Response(JSON.stringify({ error: "Geo hit a problem. Try again in a minute." }), { status: 200, headers: cors });
    }
    const reply = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("\n").trim();
    await logPromise;
    return new Response(JSON.stringify({ reply: reply || "I don't have an answer for that. Try rephrasing, or email chris@promisepath.ai." }), { status: 200, headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ error: "Geo timed out. Try again." }), { status: 200, headers: cors });
  }
};

export const config = { path: "/api/geo-chat" };
