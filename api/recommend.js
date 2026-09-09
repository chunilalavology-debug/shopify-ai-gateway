const { OpenAI } = require("openai");

const MAX_ASKS = 5;
const WINDOW_MS = 60 * 60 * 1000;
const MAX_INPUT_CHARS = 500;
const CATALOG_FILE_ID =
  process.env.OPENAI_CATALOG_FILE_ID || "file-P33L55KL75qThWXWk21toi";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const ipCache = Object.create(null);

const SYSTEM_INSTRUCTIONS = `You are a warm, expert fragrance concierge for an online perfume shop.
Speak like a real boutique advisor: friendly, concise, and specific. Never sound like a system prompt.

Always reply with a single raw JSON object and nothing else. No markdown. No extra text.

JSON schema:
{
  "reply": "1 to 3 natural sentences shown to the shopper",
  "intent": "recommend" | "clarify" | "chat",
  "title": "exact product title from the catalog, or empty string",
  "handle": "exact Shopify product handle from the catalog, or empty string",
  "bg_color": "#hex mood color"
}

Rules:
- Use the attached product catalog whenever a fragrance recommendation is possible.
- Only recommend products that actually exist in the catalog. Never invent titles or handles.
- If the shopper greets you, makes small talk, or is vague, welcome them and ask what mood, occasion, notes, or similar perfume they want. intent must be "chat". Leave title and handle empty.
- If the message is unrelated to fragrance, beauty, gifting, or shopping, politely steer back to scent finding. intent must be "chat". Leave title and handle empty.
- If you need one more detail to choose well, ask a short question. intent must be "clarify".
- When you can recommend, pick the closest catalog match, explain why it fits in plain language, and set intent to "recommend" with a real title and handle.
- If they ask for more options, recommend a different product than any previous handles.
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

function getQuota(ip) {
  const now = Date.now();
  pruneCache(now);
  if (!ipCache[ip] || now > ipCache[ip].reset) {
    ipCache[ip] = { count: 0, reset: now + WINDOW_MS };
  }
  return ipCache[ip];
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
    .slice(-6)
    .map((item) => {
      const role = item && item.role === "assistant" ? "assistant" : "user";
      const content = cleanText(item && item.content).slice(0, 280);
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
    data.reply ||
      data.explanation ||
      data.message ||
      data.description ||
      ""
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
        ? "I found a fragrance from our collection that fits what you described."
        : "Tell me a mood, occasion, or a perfume you love and I will match it from our collection."),
    intent,
    title: intent === "recommend" ? title : "",
    handle: intent === "recommend" ? handle : "",
    bg_color: bg,
  };
}

function buildUserPrompt({ text, history, previousHandles }) {
  const lines = [];
  if (history.length) {
    lines.push("Recent conversation:");
    history.forEach((item) => {
      lines.push(`${item.role === "assistant" ? "Concierge" : "Shopper"}: ${item.content}`);
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
  const content = [
    { type: "input_file", file_id: CATALOG_FILE_ID },
    { type: "input_text", text: prompt },
  ];

  const response = await openai.responses.create({
    model: MODEL,
    instructions: SYSTEM_INSTRUCTIONS,
    input: [{ role: "user", content }],
    text: { format: { type: "json_object" } },
    max_output_tokens: 400,
    temperature: 0.6,
  });

  return extractJson(response.output_text);
}

async function viaResponsesWithoutFile(openai, prompt) {
  const response = await openai.responses.create({
    model: MODEL,
    instructions: SYSTEM_INSTRUCTIONS,
    input: prompt,
    text: { format: { type: "json_object" } },
    max_output_tokens: 400,
    temperature: 0.6,
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
    temperature: 0.6,
    max_tokens: 400,
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
    console.error("Responses API with catalog file failed:", err?.message || err);
  }

  if (process.env.OPENAI_ASSISTANT_ID) {
    try {
      return await viaAssistant(openai, prompt);
    } catch (err) {
      console.error("Assistants API failed:", err?.message || err);
    }
  }

  try {
    return await viaResponsesWithoutFile(openai, prompt);
  } catch (err) {
    console.error("Responses API fallback failed:", err?.message || err);
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
      window_minutes: 60,
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const ip = getClientIp(req);
  const quota = getQuota(ip);

  if (quota.count >= MAX_ASKS) {
    const retryMins = Math.max(1, Math.ceil((quota.reset - Date.now()) / 60000));
    return res.status(429).json({
      error: "rate_limit_exceeded",
      remaining: 0,
      retry_minutes: retryMins,
      message:
        "You've reached the 5 scent searches allowed for now. Please try again after some time.",
    });
  }

  const body = readBody(req);
  const text = cleanText(body.text);

  if (!text) {
    return res.status(400).json({
      error: "bad_input",
      message: "Please type what kind of scent you are looking for.",
    });
  }

  const history = sanitizeHistory(body.history);
  const previousHandles = sanitizeHandles(body.previous_handles);
  const prompt = buildUserPrompt({ text, history, previousHandles });

  quota.count += 1;

  try {
    const openai = getOpenAIClient();
    const payload = normalizePayload(await recommend(openai, prompt));
    return res.status(200).json({
      ...payload,
      remaining: Math.max(0, MAX_ASKS - quota.count),
    });
  } catch (err) {
    quota.count = Math.max(0, quota.count - 1);
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
