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
let storeContextCache = { text: null, expiresAt: 0 };

const ipCache = Object.create(null);

const SYSTEM_INSTRUCTIONS = `You are the in-store shopping concierge for CN1 Fragrance.
Help with fragrances AND other relevant store questions: products, pricing, availability, discounts/coupons, shipping, returns, and general shopping help.
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
- Use LIVE CN1 CATALOG and STORE CONTEXT in the user message as your source of truth.
- Answer relevant shopping questions directly. Do NOT deflect with generic lines like "We specialize in fragrances..." or "we only help with scent finding."
- You may ONLY recommend products from the LIVE CN1 CATALOG. Copy title and handle exactly. Never invent products or brands CN1 does not sell.
- Product searches (e.g. hand lotion, body splash, candle): search the catalog by title, type, tags, and summary. If a match exists, answer yes, briefly explain, and set intent to "recommend" with that product. If none exists, say so clearly and optionally suggest the closest related catalog item only if it is genuinely similar. intent "chat" when nothing fits.
- Discount / coupon questions: NEVER invent coupon codes, percentages, or sale prices. Only use REAL DISCOUNT FACTS / STORE CONTEXT. If a product has no sale price and no published coupon applies, say clearly that there is no discount/coupon for it. If there is a real sale price, quote the live catalog numbers exactly.
- Pricing / availability: use catalog price and availability fields when present.
- Shipping / returns / policies: answer from STORE CONTEXT. If the exact detail is missing, say that information is not available and suggest contacting support from STORE CONTEXT when an email is listed.
- Fragrance matching still works as usual: if they name a designer perfume or mood, recommend the closest CN1 catalog match and set intent to "recommend".
- If they ask for more options, recommend a different catalog product than previous handles.
- Greetings or vague openers: welcome them and ask how you can help (scent, product type, pricing, shipping, etc.). intent "chat".
- Only refuse clearly off-topic non-shopping chatter (e.g. unrelated trivia). For those, briefly say you can help with CN1 products and store questions.
- Keep reply under 70 words.
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
        ? "I found a CN1 product that fits what you asked about."
        : "Tell me what you need — a scent, product type, price, coupon, or shipping question — and I will help from our store data."),
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

function pickVariant(variants) {
  if (!Array.isArray(variants) || !variants.length) return null;
  return (
    variants.find((item) => item && item.available) ||
    variants[0] ||
    null
  );
}

function mapProduct(item) {
  const variant = pickVariant(item.variants);
  const price = variant?.price != null ? String(variant.price) : "";
  const compareAt =
    variant?.compare_at_price != null ? String(variant.compare_at_price) : "";
  const onSale =
    price &&
    compareAt &&
    Number(compareAt) > Number(price);

  return {
    title: String(item.title || "").trim(),
    handle: String(item.handle || "").trim(),
    type: String(item.product_type || "").trim(),
    tags: Array.isArray(item.tags)
      ? item.tags.join(", ")
      : String(item.tags || ""),
    vendor: String(item.vendor || "").trim(),
    summary: stripHtml(item.body_html || "").slice(0, 180),
    price,
    compare_at_price: onSale ? compareAt : "",
    available: variant ? Boolean(variant.available) : true,
  };
}

/**
 * Fetch a single page of products from the Shopify storefront /products.json
 * endpoint. This is a public, unauthenticated endpoint available on all stores.
 *
 * @param {number} page  1-based page number
 * @returns {Promise<Array>}
 */
async function fetchProductPage(page) {
  const url = `https://${SHOP_DOMAIN}/products.json?limit=250&page=${page}`;

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
    .map(mapProduct);
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

async function fetchPolicyText(path) {
  try {
    const response = await fetch(`https://${SHOP_DOMAIN}${path}`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return "";
    const data = await response.json();
    return stripHtml(data?.policy?.body || "").slice(0, 700);
  } catch {
    return "";
  }
}

async function fetchPageText(handle) {
  try {
    const response = await fetch(
      `https://${SHOP_DOMAIN}/pages/${encodeURIComponent(handle)}.json`,
      { headers: { Accept: "application/json" } }
    );
    if (!response.ok) return "";
    const data = await response.json();
    return stripHtml(data?.page?.body_html || "").slice(0, 500);
  } catch {
    return "";
  }
}

/**
 * Public storefront context for discounts/shipping/returns.
 * Active Shopify discount codes are not exposed publicly without Admin API,
 * so we surface sale prices, free-shipping policy text, and known offer pages.
 */
async function loadStoreContext(catalog) {
  const now = Date.now();
  if (storeContextCache.text && now < storeContextCache.expiresAt) {
    return storeContextCache.text;
  }

  const [shipping, refund, riskFree] = await Promise.all([
    fetchPolicyText("/policies/shipping-policy.json"),
    fetchPolicyText("/policies/refund-policy.json"),
    fetchPageText("risk-free"),
  ]);

  const saleItems = (catalog || [])
    .filter((item) => item.compare_at_price)
    .slice(0, 8)
    .map(
      (item) =>
        `${item.title} (handle: ${item.handle}) sale $${item.price} was $${item.compare_at_price}`
    );

  const extraDiscountNotes = String(
    process.env.SHOPIFY_DISCOUNT_INFO || ""
  ).trim();

  const lines = [
    "STORE CONTEXT (answer coupon, shipping, returns, and policy questions from this):",
    shipping
      ? `Shipping policy: ${shipping}`
      : "Shipping policy: not available from storefront data.",
    refund
      ? `Returns/refunds: ${refund}`
      : "Returns/refunds: not available from storefront data.",
    riskFree ? `Risk-free offer page: ${riskFree}` : "",
    saleItems.length
      ? `Products currently showing a compare-at/sale price: ${saleItems.join("; ")}`
      : "No products currently show a compare-at/sale price in the catalog feed.",
    extraDiscountNotes
      ? `Merchant-published discount notes: ${extraDiscountNotes}`
      : "No merchant-published coupon/discount codes are included in storefront data. Do not invent coupon codes.",
    "Support email (if needed): cs@cn1fragrance.com",
  ].filter(Boolean);

  const text = lines.join("\n");
  storeContextCache = {
    text,
    expiresAt: now + CATALOG_CACHE_TTL_MS,
  };
  return text;
}

function isDiscountQuestion(text) {
  return /\b(coupon|coupan|discount|promo(\s*code)?|voucher|on\s*sale|any\s*(deal|offer|code)|sale\s*price)\b/i.test(
    String(text || "")
  );
}

/**
 * Published coupon codes only from merchant env / Admin API — never invented.
 * SHOPIFY_DISCOUNT_INFO examples:
 *   "WELCOME10: 10% off sitewide | SPRING5: $5 off"
 *   "No active coupon codes"
 */
function parsePublishedCoupons(raw) {
  const value = String(raw || "").trim();
  if (!value) return [];
  if (/^no active|^none\b|no coupon/i.test(value)) return [];

  const parts = value.split(/[|;]+/).map((part) => part.trim()).filter(Boolean);
  const coupons = [];
  for (const part of parts) {
    const match = part.match(/^([A-Z0-9][A-Z0-9_-]{2,31})\s*[:\-–]\s*(.+)$/i);
    if (match) {
      coupons.push({
        code: match[1].toUpperCase(),
        detail: match[2].trim(),
      });
    }
  }
  return coupons;
}

async function loadPublishedCoupons() {
  const fromEnv = parsePublishedCoupons(process.env.SHOPIFY_DISCOUNT_INFO);
  const token = String(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "").trim();
  const shop = String(
    process.env.SHOPIFY_SHOP || process.env.SHOPIFY_ADMIN_SHOP || ""
  )
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

  if (!token || !shop) return fromEnv;

  try {
    const endpoint = `https://${shop}/admin/api/2024-10/graphql.json`;
    const query = `{
      codeDiscountNodes(first: 25, query: "status:active") {
        nodes {
          codeDiscount {
            ... on DiscountCodeBasic {
              title
              status
              codes(first: 10) { nodes { code } }
            }
            ... on DiscountCodeBxgy {
              title
              status
              codes(first: 10) { nodes { code } }
            }
            ... on DiscountCodeFreeShipping {
              title
              status
              codes(first: 10) { nodes { code } }
            }
          }
        }
      }
    }`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query }),
    });
    if (!response.ok) return fromEnv;

    const data = await response.json();
    const nodes = data?.data?.codeDiscountNodes?.nodes || [];
    const fromAdmin = [];
    for (const node of nodes) {
      const discount = node?.codeDiscount;
      if (!discount || String(discount.status || "").toUpperCase() !== "ACTIVE") {
        continue;
      }
      const codes = discount.codes?.nodes || [];
      for (const entry of codes) {
        if (entry?.code) {
          fromAdmin.push({
            code: String(entry.code).toUpperCase(),
            detail: String(discount.title || "Active discount").trim(),
          });
        }
      }
    }

    // Prefer live Admin codes when available; keep env codes as extras.
    const merged = [...fromAdmin];
    for (const coupon of fromEnv) {
      if (!merged.some((item) => item.code === coupon.code)) merged.push(coupon);
    }
    return merged;
  } catch (err) {
    console.error("Discount Admin API failed:", err?.message || err);
    return fromEnv;
  }
}

function findReferencedProduct(text, catalog, previousHandles) {
  const list = Array.isArray(catalog) ? catalog : [];
  const lower = String(text || "").toLowerCase();

  for (const item of list) {
    const title = String(item.title || "").toLowerCase();
    const handle = String(item.handle || "").toLowerCase();
    if (!title || !handle) continue;
    if (lower.includes(handle) || lower.includes(title)) return item;
  }

  let best = null;
  let bestScore = 0;
  for (const item of list) {
    const words = String(item.title || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3);
    const hits = words.filter((word) => lower.includes(word)).length;
    if (hits >= 2 && hits > bestScore) {
      best = item;
      bestScore = hits;
    }
  }
  if (best) return best;

  const handles = Array.isArray(previousHandles) ? previousHandles : [];
  for (let i = handles.length - 1; i >= 0; i -= 1) {
    const match = list.find((item) => item.handle === handles[i]);
    if (match) return match;
  }
  return null;
}

function productHasSale(product) {
  if (!product || !product.price || !product.compare_at_price) return false;
  return Number(product.compare_at_price) > Number(product.price);
}

/**
 * Build a factual discount/coupon reply from live catalog + published codes only.
 * This path does not ask the model to invent deals.
 */
function buildFactualDiscountReply({ text, catalog, previousHandles, coupons }) {
  const product = findReferencedProduct(text, catalog, previousHandles);
  const published = Array.isArray(coupons) ? coupons : [];
  const hasCoupons = published.length > 0;

  if (product) {
    const onSale = productHasSale(product);
    if (onSale && hasCoupons) {
      const codes = published
        .map((item) => `${item.code} (${item.detail})`)
        .join("; ");
      return {
        reply: `Yes — ${product.title} is on sale at $${product.price} (was $${product.compare_at_price}). Published coupon code(s): ${codes}.`,
        intent: "recommend",
        title: product.title,
        handle: product.handle,
        bg_color: "#c4a07a",
      };
    }
    if (onSale) {
      return {
        reply: `Yes — ${product.title} currently has a real sale price of $${product.price} (was $${product.compare_at_price}). There is no published coupon code for it right now.`,
        intent: "recommend",
        title: product.title,
        handle: product.handle,
        bg_color: "#c4a07a",
      };
    }
    if (hasCoupons) {
      const codes = published
        .map((item) => `${item.code} (${item.detail})`)
        .join("; ");
      return {
        reply: `${product.title} is $${product.price} with no product sale price right now. Published coupon code(s) you can try: ${codes}.`,
        intent: "recommend",
        title: product.title,
        handle: product.handle,
        bg_color: "#c9e2e8",
      };
    }
    return {
      reply: `No — ${product.title} is currently $${product.price || "priced as listed"} with no active product discount and no published coupon code available right now.`,
      intent: "recommend",
      title: product.title,
      handle: product.handle,
      bg_color: "#c9e2e8",
    };
  }

  const saleItems = (catalog || []).filter(productHasSale).slice(0, 5);
  if (hasCoupons) {
    const codes = published
      .map((item) => `${item.code} (${item.detail})`)
      .join("; ");
    const saleBit = saleItems.length
      ? ` Also on sale now: ${saleItems
          .map((item) => `${item.title} $${item.price} (was $${item.compare_at_price})`)
          .join("; ")}.`
      : "";
    return {
      reply: `Published coupon code(s): ${codes}.${saleBit}`,
      intent: "chat",
      title: "",
      handle: "",
      bg_color: "#c9e2e8",
    };
  }

  if (saleItems.length) {
    return {
      reply: `There is no published coupon code right now. These products currently show a real sale price: ${saleItems
        .map((item) => `${item.title} $${item.price} (was $${item.compare_at_price})`)
        .join("; ")}.`,
      intent: "chat",
      title: "",
      handle: "",
      bg_color: "#c9e2e8",
    };
  }

  return {
    reply:
      "No — there is no published coupon code right now, and no products currently show an active sale price in the live catalog.",
    intent: "chat",
    title: "",
    handle: "",
    bg_color: "#c9e2e8",
  };
}

function formatCatalog(catalog) {
  if (!catalog.length) return "LIVE CN1 CATALOG: no products available.";
  return [
    "LIVE CN1 CATALOG (recommend only from this list):",
    ...catalog.map((item, index) => {
      const priceBit = item.price ? `price: $${item.price}` : "price: n/a";
      const saleBit = item.compare_at_price
        ? ` sale was $${item.compare_at_price}`
        : "";
      const stockBit = item.available === false ? "out of stock" : "in stock";
      return `${index + 1}. ${item.title} | handle: ${item.handle} | ${item.type || "product"} | ${item.vendor} | ${item.tags} | ${priceBit}${saleBit} | ${stockBit} | ${item.summary}`;
    }),
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
          "I could not verify that product in the live catalog right now. Ask me about a scent, product type, price, or shipping and I will help from store data.",
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

  // Do not force a random first catalog product when the model had no valid match.
  // Preserve a helpful chat answer (e.g. "we don't carry hand lotion").
  if (payload.intent === "recommend") {
    return {
      ...payload,
      intent: "chat",
      title: "",
      handle: "",
      reply:
        payload.reply ||
        "I could not find an exact catalog match for that. Tell me another product type, scent, or question about the store.",
    };
  }

  return { ...payload, title: "", handle: "" };
}

function buildUserPrompt({ text, history, previousHandles, catalog, storeContext }) {
  const lines = [formatCatalog(catalog), "", storeContext || "", ""];
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
      `Recently recommended product handles (for follow-up coupon/product questions): ${previousHandles.join(", ")}`
    );
    lines.push(
      `If suggesting another product, prefer a different handle than: ${previousHandles.join(", ")}`
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

  // Always load live Shopify catalog + store policies for shopping questions
  // (products, pricing, coupons/deals, shipping). Skip only pure greetings.
  const catalog = looksLikeScentQuery(text)
    ? await loadFullCatalog().catch(() => [])
    : [];
  const storeContext = looksLikeScentQuery(text)
    ? await loadStoreContext(catalog).catch(() => "")
    : "";

  sessionQuota.count += 1;
  if (ipQuota !== sessionQuota) ipQuota.count += 1;

  try {
    // Discount/coupon questions use live catalog sale prices + published codes only.
    // Skip the model so it cannot invent fake coupons or discounts.
    if (isDiscountQuestion(text)) {
      const coupons = await loadPublishedCoupons().catch(() => []);
      const payload = buildFactualDiscountReply({
        text,
        catalog,
        previousHandles,
        coupons,
      });
      return res.status(200).json({
        ...payload,
        remaining: Math.max(0, MAX_ASKS - sessionQuota.count),
      });
    }

    const prompt = buildUserPrompt({
      text,
      history,
      previousHandles,
      catalog,
      storeContext,
    });
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
  SYSTEM_INSTRUCTIONS,
  countWords,
  cleanText,
  sanitizeHistory,
  sanitizeSession,
  getQuota,
  ipCache,
  bindToCatalog,
  formatCatalog,
  mapProduct,
  isDiscountQuestion,
  parsePublishedCoupons,
  findReferencedProduct,
  productHasSale,
  buildFactualDiscountReply,
};
