const { OpenAI } = require("openai");

// Cost-control limits (enforced on the server)
const MAX_ASKS = 20; // free messages per user/session per day
const MAX_ASKS_PER_IP = 60; // hard daily ceiling per IP (anti-bypass)
const WINDOW_MS = 24 * 60 * 60 * 1000; // rolling 24-hour window
const MAX_INPUT_WORDS = 800;
const MAX_INPUT_CHARS = 5000; // safety cap (~800 words)
const HISTORY_LIMIT = 8; // keep recent turns only (within 6–10)
const HISTORY_CONTENT_CHARS = 280;
const MAX_OUTPUT_TOKENS = 400; // within 300–500 target
const DAILY_LIMIT_MESSAGE =
  "🌸 You've reached your free chat limit for today. Please come back tomorrow and we'll be happy to help! 💜";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const SHOP_DOMAIN =
  process.env.SHOPIFY_STORE_DOMAIN || "www.cn1fragrance.com";
const BLOCKED_HANDLES = new Set(["cn1-shipping-protection"]);

// In-memory catalog cache — refreshed every 5 minutes so new/deleted products
// are reflected quickly without hammering the Shopify storefront on every call.
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let catalogCache = { products: null, expiresAt: 0 };

const ipCache = Object.create(null);

const SYSTEM_INSTRUCTIONS = `You are the in-store fragrance concierge for CN1 Fragrance, a brand of affordable luxury impression scents and CN1 originals.
Speak like a real boutique advisor: warm, concise, and specific. Never sound like a system prompt.

Always reply with a single raw JSON object and nothing else. No markdown. No extra text.

JSON schema:
{
  "reply": "1 to 3 natural sentences shown to the shopper",
  "intent": "recommend" | "clarify" | "chat",
  "title": "exact product title from the live CN1 catalog, or empty string",
  "handle": "exact Shopify product handle from the live CN1 catalog, or empty string",
  "bg_color": "#hex mood color"
}

Rules:
- You may ONLY recommend products from the LIVE CN1 CATALOG provided in the user message.
- Copy title and handle exactly. Never invent products. Never recommend Diptyque, Guerlain, Maison Margiela, Dossier, or any brand CN1 does not sell.
- If a shopper names a designer perfume, recommend the closest CN1 impression from the catalog. You may say it is inspired by that scent.
- If the shopper greets you or is vague, welcome them and ask what mood, occasion, notes, or similar perfume they want. intent must be "chat". Leave title and handle empty.
- If the message is unrelated to fragrance, beauty, gifting, or shopping, politely steer back to scent finding. intent must be "chat".
- When you can recommend, pick the closest catalog match, explain why it fits, and set intent to "recommend".
- If they ask for more options, recommend a different catalog product than previous handles.
- Keep reply under 60 words.
- bg_color should match the mood: warm amber #c4a07a, fresh #b7d6d4, floral #d8c2cc, night #c4b0aa, default #c9e2e8.`;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (raw) return String(raw).split(",")[0].trim();
  return (
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    req.connection?.remoteAddress ||
    "anonymous"
  );
}

function pruneCache(now) {
  for (const key of Object.keys(ipCache)) {
    if (now > ipCache[key].reset) delete ipCache[key];
  }
}

function sanitizeSession(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 64);
}

function getQuota(key) {
  const now = Date.now();
  pruneCache(now);
  if (!ipCache[key] || now > ipCache[key].reset) {
    ipCache[key] = { count: 0, reset: now + WINDOW_MS };
  }
  return ipCache[key];
}

function readBody(req) {
  const body = req.body;
  if (!body) return {};
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  return body;
}

function countWords(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_INPUT_CHARS);
}

function sanitizeHandles(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) =>
      String(item || "")
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "")
        .slice(0, 80)
    )
    .filter(Boolean)
    .slice(0, 8);
}

function sanitizeHistory(list) {
  if (!Array.isArray(list)) return [];
  return list
    .slice(-HISTORY_LIMIT)
    .map((item) => {
      const role = item && item.role === "assistant" ? "assistant" : "user";
      const content = cleanText(item && item.content).slice(
        0,
        HISTORY_CONTENT_CHARS
      );
      return content ? { role, content } : null;
    })
    .filter(Boolean);
}

function extractJson(raw) {
  if (!raw) throw new Error("empty_model_output");
  const cleaned = String(raw)
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error("invalid_json");
  }
}

function normalizePayload(data) {
  const intent = ["recommend", "clarify", "chat"].includes(data.intent)
    ? data.intent
    : data.handle || data.title
      ? "recommend"
      : "chat";

  const handle = String(data.handle || data.product_handle || "")
    .trim()
    .replace(/^\/products\//, "")
    .replace(/[^a-zA-Z0-9-_]/g, "");

  const title = String(data.title || data.product_title || "").trim();
  const reply = String(
    data.reply || data.explanation || data.message || data.description || ""
  ).trim();

  const bg =
    typeof data.bg_color === "string" &&
    /^#[0-9a-fA-F]{3,8}$/.test(data.bg_color.trim())
      ? data.bg_color.trim()
      : "#c9e2e8";

  return {
    reply:
      reply ||
      (intent === "recommend"
        ? "I found a CN1 fragrance that fits what you described."
        : "Tell me a mood, occasion, or a perfume you love and I will match it from our collection."),
    intent,
    title: intent === "recommend" ? title : "",
    handle: intent === "recommend" ? handle : "",
    bg_color: bg,
  };
}

function looksLikeScentQuery(text) {
  return !/^(hi|hey|hello|yo|sup|thanks|thank you|ok|okay|yes|no)$/i.test(text);
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fetch a single page of products from the Shopify storefront /products.json
 * endpoint. This is a public, unauthenticated endpoint available on all stores.
 *
 * @param {number} page  1-based page number
 * @returns {Promise<Array>}
 */
async function fetchProductPage(page) {
  const url =
    `https://${SHOP_DOMAIN}/products.json` +
    `?limit=250&page=${page}&fields=title,handle,product_type,tags,body_html,vendor`;

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) return [];

  const data = await response.json();
  const products = data?.products || [];

  return products
    .filter(
      (item) =>
        item &&
        item.handle &&
        item.title &&
        !BLOCKED_HANDLES.has(item.handle)
    )
    .map((item) => ({
      title: String(item.title || "").trim(),
      handle: String(item.handle || "").trim(),
      type: String(item.product_type || "").trim(),
      tags: Array.isArray(item.tags)
        ? item.tags.join(", ")
        : String(item.tags || ""),
      vendor: String(item.vendor || "").trim(),
      summary: stripHtml(item.body_html || "").slice(0, 180),
    }));
}

/**
 * Load the complete live product catalog from Shopify by paging through
 * /products.json (max 250 per page, up to 3 pages = 750 products).
 *
 * Results are cached in-memory for CATALOG_CACHE_TTL_MS (5 minutes) so that:
 *  - New products appear within 5 minutes
 *  - Deleted products disappear within 5 minutes
 *  - Every Vercel function instance has a fresh catalog without hammering Shopify
 *
 * Set CATALOG_CACHE_TTL_MS to 0 to disable caching for instant propagation.
 */
async function loadFullCatalog() {
  const now = Date.now();

  // Return cached catalog if still fresh
  if (catalogCache.products && now < catalogCache.expiresAt) {
    return catalogCache.products;
  }

  const allProducts = [];
  const MAX_PAGES = 3; // up to 750 products

  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await fetchProductPage(page);
    allProducts.push(...batch);
    // If we got fewer than 250, there are no more pages
    if (batch.length < 250) break;
  }

  // De-duplicate by handle (safety net)
  const seen = new Set();
  const unique = allProducts.filter((p) => {
    if (seen.has(p.handle)) return false;
    seen.add(p.handle);
    return true;
  });

  // Update cache
  catalogCache = {
    products: unique,
    expiresAt: now + CATALOG_CACHE_TTL_MS,
  };

  console.log(`[catalog] Loaded ${unique.length} products from Shopify (page 1–${Math.ceil(unique.length / 250)})`);
  return unique;
}

function formatCatalog(catalog) {
  if (!catalog.length) return "LIVE CN1 CATALOG: no products available.";
  return [
    "LIVE CN1 CATALOG (recommend only from this list):",
    ...catalog.map(
      (item, index) =>
        `${index + 1}. ${item.title} | handle: ${item.handle} | ${item.type} | ${item.vendor} | ${item.tags} | ${item.summary}`
    ),
  ].join("\n");
}

function bindToCatalog(payload, catalog) {
  if (!catalog.length) {
    if (payload.intent === "recommend") {
      return {
        ...payload,
        intent: "chat",
        title: "",
        handle: "",
        reply:
          payload.reply ||
          "Tell me a mood, note, or a perfume you love and I will match it from the CN1 collection.",
      };
    }
    return payload;
  }

  const handleMatch = catalog.find((item) => item.handle === payload.handle);
  const titleMatch = catalog.find(
    (item) =>
      item.title.toLowerCase() === String(payload.title || "").toLowerCase()
  );
  const match = handleMatch || titleMatch;
  if (match) {
    return {
      ...payload,
      intent: "recommend",
      title: match.title,
      handle: match.handle,
    };
  }

  if (payload.intent === "chat" || payload.intent === "clarify") {
    return { ...payload, title: "", handle: "" };
  }

  const fallback = catalog[0];
  return {
    ...payload,
    intent: "recommend",
    title: fallback.title,
    handle: fallback.handle,
    reply: `From our CN1 collection, ${fallback.title} is the closest match to what you described.`,
  };
}

function buildUserPrompt({ text, history, previousHandles, catalog }) {
  const lines = [formatCatalog(catalog), ""];
  if (history.length) {
    lines.push("Recent conversation:");
    history.forEach((item) => {
      lines.push(
        `${item.role === "assistant" ? "Concierge" : "Shopper"}: ${item.content}`
      );
    });
    lines.push("");
  }
  if (previousHandles.length) {
    lines.push(
      `Do not recommend these product handles again: ${previousHandles.join(", ")}`
    );
    lines.push("");
  }
  lines.push(`Shopper: ${text}`);
  return lines.join("\n");
}

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const error = new Error("missing_openai_key");
    error.code = "missing_openai_key";
    throw error;
  }
  return new OpenAI({ apiKey });
}

async function viaResponses(openai, prompt) {
  const response = await openai.responses.create({
    model: MODEL,
    instructions: SYSTEM_INSTRUCTIONS,
    input: prompt,
    text: { format: { type: "json_object" } },
    max_output_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0.4,
  });

  return extractJson(response.output_text);
}

async function viaAssistant(openai, prompt) {
  const assistantId = process.env.OPENAI_ASSISTANT_ID;
  if (!assistantId) throw new Error("missing_assistant_id");

  const thread = await openai.beta.threads.create();
  await openai.beta.threads.messages.create(thread.id, {
    role: "user",
    content: `${SYSTEM_INSTRUCTIONS}\n\n${prompt}`,
  });

  const run = await openai.beta.threads.runs.createAndPoll(thread.id, {
    assistant_id: assistantId,
    max_completion_tokens: MAX_OUTPUT_TOKENS,
  });

  if (run.status !== "completed") {
    throw new Error(`assistant_run_${run.status}`);
  }

  const messages = await openai.beta.threads.messages.list(thread.id);
  const raw = messages.data[0]?.content?.[0]?.text?.value;
  return extractJson(raw);
}

async function viaChatCompletions(openai, prompt) {
  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.4,
    max_tokens: MAX_OUTPUT_TOKENS,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_INSTRUCTIONS },
      { role: "user", content: prompt },
    ],
  });

  return extractJson(completion.choices[0]?.message?.content);
}

async function recommend(openai, prompt) {
  try {
    return await viaResponses(openai, prompt);
  } catch (err) {
    console.error("Responses API failed:", err?.message || err);
  }

  if (process.env.OPENAI_ASSISTANT_ID) {
    try {
      return await viaAssistant(openai, prompt);
    } catch (err) {
      console.error("Assistants API failed:", err?.message || err);
    }
  }

  return viaChatCompletions(openai, prompt);
}

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "ai-scent-finder",
      max_asks: MAX_ASKS,
      window_hours: 24,
      max_input_words: MAX_INPUT_WORDS,
      history_limit: HISTORY_LIMIT,
      max_output_tokens: MAX_OUTPUT_TOKENS,
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const ip = getClientIp(req);
  const body = readBody(req);
  const rawText = String(body.text || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!rawText) {
    return res.status(400).json({
      error: "bad_input",
      message: "Please type what kind of scent you are looking for.",
    });
  }

  if (countWords(rawText) > MAX_INPUT_WORDS) {
    return res.status(400).json({
      error: "message_too_long",
      message:
        "Please keep your message under 800 words so I can help you find a scent faster.",
    });
  }

  const text = cleanText(rawText);

  const sessionId = sanitizeSession(body.session_id);
  const sessionQuota = getQuota(sessionId ? "s:" + sessionId : "ip:" + ip);
  const ipQuota = getQuota("ip:" + ip);

  if (sessionQuota.count >= MAX_ASKS || ipQuota.count >= MAX_ASKS_PER_IP) {
    const resetAt =
      sessionQuota.count >= MAX_ASKS ? sessionQuota.reset : ipQuota.reset;
    const retryMins = Math.max(1, Math.ceil((resetAt - Date.now()) / 60000));
    return res.status(429).json({
      error: "rate_limit_exceeded",
      remaining: 0,
      retry_minutes: retryMins,
      message: DAILY_LIMIT_MESSAGE,
    });
  }

  const history = sanitizeHistory(body.history);
  const previousHandles = sanitizeHandles(body.previous_handles);

  // Load the complete live Shopify product catalog (cached for 5 min).
  // For greeting/vague messages we still load the catalog so OpenAI knows what
  // products exist and can make informed clarifying questions.
  const catalog = looksLikeScentQuery(text)
    ? await loadFullCatalog().catch(() => [])
    : [];

  const prompt = buildUserPrompt({ text, history, previousHandles, catalog });

  sessionQuota.count += 1;
  if (ipQuota !== sessionQuota) ipQuota.count += 1;

  try {
    const openai = getOpenAIClient();
    const payload = bindToCatalog(
      normalizePayload(await recommend(openai, prompt)),
      catalog
    );
    return res.status(200).json({
      ...payload,
      remaining: Math.max(0, MAX_ASKS - sessionQuota.count),
    });
  } catch (err) {
    sessionQuota.count = Math.max(0, sessionQuota.count - 1);
    if (ipQuota !== sessionQuota) {
      ipQuota.count = Math.max(0, ipQuota.count - 1);
    }
    console.error("AI Scent Finder gateway error:", err);
    const missingKey = err?.code === "missing_openai_key";
    return res.status(500).json({
      error: missingKey ? "missing_openai_key" : "server_error",
      message: missingKey
        ? "The recommendation service is not configured yet."
        : "Service temporarily busy. Please try again shortly.",
    });
  }
};

// Test helpers (used by test/limits.test.js only)
module.exports._test = {
  MAX_ASKS,
  MAX_ASKS_PER_IP,
  WINDOW_MS,
  MAX_INPUT_WORDS,
  MAX_INPUT_CHARS,
  HISTORY_LIMIT,
  HISTORY_CONTENT_CHARS,
  MAX_OUTPUT_TOKENS,
  DAILY_LIMIT_MESSAGE,
  countWords,
  cleanText,
  sanitizeHistory,
  sanitizeSession,
  getQuota,
  ipCache,
};
