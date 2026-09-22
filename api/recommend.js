const { OpenAI } = require("openai");

// Cost-control limits (enforced on the server)
const MAX_ASKS = 20; // free messages per user/session per day
const MAX_ASKS_PER_IP = 60; // hard daily ceiling per IP (anti-bypass)
const WINDOW_MS = 24 * 60 * 60 * 1000; // rolling 24-hour window
const MAX_INPUT_WORDS = 800;
const MAX_INPUT_CHARS = 5000; // safety cap (~800 words)
const HISTORY_LIMIT = 8; // keep recent turns only (within 6–10)
const HISTORY_CONTENT_CHARS = 400;
const MAX_OUTPUT_TOKENS = 450; // within 300–500 target
const DAILY_LIMIT_MESSAGE =
  "🌸 You've reached your free chat limit for today. Please come back tomorrow and we'll be happy to help! 💜";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const SHOP_DOMAIN =
  process.env.SHOPIFY_STORE_DOMAIN || "www.cn1fragrance.com";
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";
const BLOCKED_HANDLES = new Set(["cn1-shipping-protection"]);

// In-memory caches — refreshed every 5 minutes
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
let catalogCache = { products: null, expiresAt: 0 };
let storeContextCache = { text: null, expiresAt: 0 };
let collectionsCache = { map: null, expiresAt: 0 };
let shopifyTokenCache = { token: null, expiresAt: 0 };
let resolvedShopifyShop = null;

const ipCache = Object.create(null);

/**
 * Final-answer prompt. The model may ONLY use STORE DATA FACTS provided
 * in the user message — never invent products, prices, coupons, or policies.
 */
const SYSTEM_INSTRUCTIONS = `You are the in-store shopping concierge for CN1 Fragrance.
Answer customer questions about products, recommendations, pricing, availability, discounts, shipping, returns, notes, ingredients, and general store help.

Always reply with a single raw JSON object and nothing else. No markdown fences.

JSON schema:
{
  "reply": "natural customer-friendly answer",
  "intent": "recommend" | "clarify" | "chat",
  "title": "exact product title from STORE DATA FACTS, or empty string (use for single product)",
  "handle": "exact Shopify product handle from STORE DATA FACTS, or empty string (use for single product)",
  "products": [{"title": "exact product title", "handle": "exact product handle"}],
  "bg_color": "#hex mood color"
}

Hard rules:
- Use ONLY STORE DATA FACTS and conversation history. Never invent product names, prices, coupons, stock, notes, ingredients, shipping, returns, or URLs.
- Prefer metafield values in STORE DATA FACTS for fragrance notes, ingredients, longevity, gender, and occasion when present.
- If a fact is missing from STORE DATA FACTS, say it is not currently available.
- Do NOT deflect with generic lines like "We specialize in fragrances..." — answer the question.
- IMPORTANT: When recommending ONE product: set title + handle, and products = [{title, handle}].
- IMPORTANT: When recommending MULTIPLE products (e.g. listing a collection, comparing, or showing options): set intent to "recommend", leave title/handle as empty string, and populate the products array with ALL recommended products in order. Each entry must have exact title and handle from STORE DATA FACTS.
- For follow-ups ("this one", "that perfume", "something cheaper"), use Focused product / Recently discussed products in the facts.
- Discount/coupon answers must match REAL DISCOUNT FACTS exactly. Never invent a code.
- If recommending an alternative, pick a different handle than ones already recommended when possible.
- bg_color mood defaults: warm #c4a07a, fresh #b7d6d4, floral #d8c2cc, night #c4b0aa, default #c9e2e8.

STRICT REPLY FORMAT RULES (very important):
- The "reply" field is plain conversational text ONLY. The frontend renders product cards separately.
- NEVER include URLs, markdown links ([text](url)), or product page links in reply.
- NEVER include product handles in reply.
- NEVER include prices in reply (they appear on the product card).
- NEVER use **bold** or markdown formatting in reply.
- NEVER repeat product details (price, availability, URL) that will appear on the card.
- For single product: write 1-2 sentences explaining why you recommend it.
- For multiple products: write one short intro sentence (e.g. "Here are some great options with amber notes:") then list each product name followed by one short reason. Do NOT include prices, links, or handles.
- Keep reply under 100 words total.`;

const CLASSIFY_INSTRUCTIONS = `Classify the shopper message for a Shopify fragrance store assistant.
Return ONLY JSON:
{
  "query_type": "greeting" | "recommend" | "product_info" | "discount" | "shipping" | "returns" | "compare" | "chat" | "off_topic",
  "needs_catalog": true/false,
  "needs_policies": true/false,
  "needs_discounts": true/false,
  "focus_previous": true/false,
  "search_terms": ["keywords for product search"]
}
Rules:
- greeting: hi/thanks/ok only → needs_* false
- recommend / compare / budget / occasion / notes matching → needs_catalog true
- price/availability/notes/ingredients/longevity/unisex about a product → product_info, needs_catalog true, focus_previous true if they say this/that/it
- coupon/discount/sale → discount, needs_catalog true, needs_discounts true, focus_previous true for this product
- shipping → shipping, needs_policies true
- returns/refund → returns, needs_policies true
- off_topic non-shopping → off_topic
- search_terms: 2–8 useful keywords from the request (citrus, date night, under 40, etc.)`;

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
    : data.handle || data.title || (Array.isArray(data.products) && data.products.length)
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

  // Normalize the products array (multi-product recommendations)
  const rawProducts = Array.isArray(data.products) ? data.products : [];
  const products = rawProducts
    .map((item) => ({
      title: String(item?.title || "").trim(),
      handle: String(item?.handle || "")
        .trim()
        .replace(/^\/products\//, "")
        .replace(/[^a-zA-Z0-9-_]/g, ""),
    }))
    .filter((item) => item.handle && item.title)
    .slice(0, 8);

  // If AI gave a single handle but no products array, promote it into products
  if (intent === "recommend" && handle && !products.length) {
    if (title) products.push({ title, handle });
  }

  return {
    reply:
      reply ||
      (intent === "recommend"
        ? "I found a CN1 product that fits what you asked about."
        : "Tell me what you need — a scent, product type, price, coupon, or shipping question — and I will help from our store data."),
    intent,
    title: intent === "recommend" ? title : "",
    handle: intent === "recommend" ? handle : "",
    products: intent === "recommend" ? products : [],
    bg_color: bg,
  };
}

function looksLikeScentQuery(text) {
  return !/^(hi|hey|hello|yo|sup|thanks|thank you|ok|okay|yes|no)$/i.test(text);
}

/**
 * Strip markdown links [text](url), **bold**, handle lines, URL-only lines,
 * and price lines from the AI reply so the chat bubble stays clean.
 * Product cards handle all of that information.
 */
function sanitizeReply(reply) {
  return String(reply || "")
    // Remove markdown links [label](url) -> keep only the label
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Remove bare URLs
    .replace(/https?:\/\/[^\s)]+/g, "")
    // Remove lines that are just "Handle: xxx"
    .replace(/^\s*-?\s*handle\s*:\s*\S+\s*$/gim, "")
    // Remove lines that are just "- Price: $xx" or "Price: $xx"
    .replace(/^\s*-?\s*price\s*:\s*\$[\d.,]+\s*$/gim, "")
    // Remove lines that are just "- [View Product]" or similar
    .replace(/^\s*-?\s*\[view product\].*$/gim, "")
    // Remove **bold** markers but keep the text inside
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    // Remove leftover markdown * or _ emphasis
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, "$1")
    // Collapse multiple blank lines into one
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getConfiguredShopifyShop() {
  return String(process.env.SHOPIFY_SHOP || process.env.SHOPIFY_ADMIN_SHOP || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

function getShopifyShop() {
  return String(resolvedShopifyShop || getConfiguredShopifyShop() || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

/**
 * Resolve the real *.myshopify.com domain from storefront meta.json.
 * Custom/vanity values like cn1fragrance.myshopify.com can 404 for Admin OAuth.
 */
async function resolveShopifyShop(force = false) {
  if (!force && resolvedShopifyShop) return resolvedShopifyShop;

  try {
    const response = await fetch(`https://${SHOP_DOMAIN}/meta.json`, {
      headers: { Accept: "application/json" },
    });
    if (response.ok) {
      const meta = await response.json();
      const domain = String(meta?.myshopify_domain || "")
        .trim()
        .replace(/^https?:\/\//, "")
        .replace(/\/$/, "");
      if (domain) {
        resolvedShopifyShop = domain;
        console.log("[shopify] resolved myshopify domain:", domain);
        return domain;
      }
    }
  } catch (err) {
    console.warn("resolveShopifyShop failed:", err?.message || err);
  }

  return getConfiguredShopifyShop();
}

function hasShopifyClientCredentials() {
  return Boolean(
    getShopifyShop() &&
      String(process.env.SHOPIFY_CLIENT_ID || "").trim() &&
      String(process.env.SHOPIFY_CLIENT_SECRET || "").trim()
  );
}

function hasShopifyAdminAuth() {
  return (
    hasShopifyClientCredentials() ||
    Boolean(String(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "").trim())
  );
}

/**
 * Shopify Client Credentials Grant (server-side only).
 * Caches the access token and refreshes ~60s before expiry.
 * Docs: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
 */
async function getShopifyAccessToken(forceRefresh = false) {
  if (
    !forceRefresh &&
    shopifyTokenCache.token &&
    Date.now() < shopifyTokenCache.expiresAt - 60_000
  ) {
    return shopifyTokenCache.token;
  }

  const clientId = String(process.env.SHOPIFY_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.SHOPIFY_CLIENT_SECRET || "").trim();

  if (clientId && clientSecret) {
    let shop = (await resolveShopifyShop()) || getConfiguredShopifyShop();
    if (!shop) {
      throw new Error("missing_shopify_shop");
    }

    async function requestToken(shopDomain) {
      const response = await fetch(
        `https://${shopDomain}/admin/oauth/access_token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: clientId,
            client_secret: clientSecret,
          }),
        }
      );
      return response;
    }

    let response = await requestToken(shop);

    // Wrong SHOPIFY_SHOP → resolve real domain from meta.json and retry.
    if (!response.ok) {
      const discovered = await resolveShopifyShop(true);
      if (discovered && discovered !== shop) {
        shop = discovered;
        resolvedShopifyShop = discovered;
        response = await requestToken(shop);
      }
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `shopify_client_credentials_failed_${response.status}:${detail.slice(0, 180)}`
      );
    }

    const data = await response.json();
    const expiresIn = Number(data.expires_in) || 86399;
    shopifyTokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
    };
    return shopifyTokenCache.token;
  }

  const staticToken = String(
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || ""
  ).trim();
  if (staticToken) return staticToken;

  throw new Error("missing_shopify_credentials");
}

async function shopifyAdminGraphql(query, variables = {}, retried = false) {
  const shop = getShopifyShop();
  if (!shop) throw new Error("missing_shopify_shop");

  const token = await getShopifyAccessToken(retried);
  const response = await fetch(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (response.status === 401 && !retried && hasShopifyClientCredentials()) {
    shopifyTokenCache = { token: null, expiresAt: 0 };
    return shopifyAdminGraphql(query, variables, true);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `shopify_graphql_http_${response.status}:${detail.slice(0, 180)}`
    );
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(
      `shopify_graphql_error:${payload.errors
        .map((err) => err.message)
        .join("; ")
        .slice(0, 240)}`
    );
  }
  return payload.data;
}

function metafieldMap(nodes) {
  const map = Object.create(null);
  for (const node of nodes || []) {
    if (!node?.namespace || !node?.key) continue;
    const key = `${node.namespace}.${node.key}`;
    map[key] = String(node.value || "").trim();
  }
  return map;
}

function pickMetafield(map, candidates) {
  for (const key of candidates) {
    if (map[key]) return map[key];
    const lowerKey = Object.keys(map).find(
      (item) => item.toLowerCase() === key.toLowerCase()
    );
    if (lowerKey && map[lowerKey]) return map[lowerKey];
  }
  // Fallback: match by key suffix
  for (const candidate of candidates) {
    const suffix = candidate.includes(".")
      ? candidate.split(".").pop()
      : candidate;
    const found = Object.keys(map).find((item) =>
      item.toLowerCase().endsWith("." + String(suffix).toLowerCase())
    );
    if (found && map[found]) return map[found];
  }
  return "";
}

function mapAdminProduct(node) {
  const handle = String(node?.handle || "").trim();
  const description = stripHtml(
    node?.description || node?.descriptionHtml || ""
  );
  const variants = (node?.variants?.nodes || []).map((entry) => ({
    title: String(entry.title || "Default").trim(),
    price: entry.price != null ? String(entry.price) : "",
    compare_at_price:
      entry.compareAtPrice != null ? String(entry.compareAtPrice) : "",
    available: Boolean(entry.availableForSale),
    sku: String(entry.sku || ""),
    inventory_quantity:
      entry.inventoryQuantity == null ? null : Number(entry.inventoryQuantity),
  }));
  const variant =
    variants.find((item) => item.available) || variants[0] || null;
  const price = variant?.price || "";
  const compareAt = variant?.compare_at_price || "";
  const onSale =
    price && compareAt && Number(compareAt) > Number(price);
  const fields = metafieldMap(node?.metafields?.nodes || []);
  const notes =
    pickMetafield(fields, [
      "custom.fragrance_notes",
      "custom.notes",
      "custom.scent_notes",
      "descriptors.fragrance_notes",
      "shopify.fragrance-notes",
    ]) || extractNotes(description);
  const ingredients = pickMetafield(fields, [
    "custom.ingredients",
    "custom.ingredient_list",
    "descriptors.ingredients",
  ]);
  const longevity = pickMetafield(fields, [
    "custom.longevity",
    "custom.wear_time",
    "descriptors.longevity",
  ]);
  const gender = pickMetafield(fields, [
    "custom.gender",
    "custom.unisex",
    "descriptors.gender",
  ]);
  const occasion = pickMetafield(fields, [
    "custom.occasion",
    "descriptors.occasion",
  ]);

  return {
    title: String(node?.title || "").trim(),
    handle,
    type: String(node?.productType || "").trim(),
    tags: Array.isArray(node?.tags) ? node.tags.join(", ") : String(node?.tags || ""),
    vendor: String(node?.vendor || "").trim(),
    summary: description.slice(0, 220),
    description: description.slice(0, 700),
    notes,
    ingredients,
    longevity,
    gender,
    occasion,
    metafields: fields,
    price,
    compare_at_price: onSale ? compareAt : "",
    available: variant ? Boolean(variant.available) : true,
    inventory_quantity: variant?.inventory_quantity,
    url: handle ? `https://${SHOP_DOMAIN}/products/${handle}` : "",
    image: String(node?.featuredImage?.url || ""),
    variants: variants.slice(0, 8),
    collections: (node?.collections?.nodes || [])
      .map((item) => String(item.title || "").trim())
      .filter(Boolean)
      .slice(0, 6),
    source: "admin",
  };
}

async function loadCatalogFromAdmin() {
  const baseProductFields = `
    id
    title
    handle
    status
    productType
    vendor
    tags
    description
    descriptionHtml
    featuredImage { url }
    collections(first: 6) { nodes { title handle } }
    metafields(first: 40) {
      nodes { namespace key type value }
    }
  `;

  const queryWithInventory = `
    query ProductsPage($cursor: String) {
      products(first: 50, after: $cursor, query: "status:active") {
        pageInfo { hasNextPage endCursor }
        nodes {
          ${baseProductFields}
          variants(first: 25) {
            nodes {
              id
              title
              sku
              price
              compareAtPrice
              availableForSale
              inventoryQuantity
            }
          }
        }
      }
    }
  `;

  const queryWithoutInventory = `
    query ProductsPage($cursor: String) {
      products(first: 50, after: $cursor, query: "status:active") {
        pageInfo { hasNextPage endCursor }
        nodes {
          ${baseProductFields}
          variants(first: 25) {
            nodes {
              id
              title
              sku
              price
              compareAtPrice
              availableForSale
            }
          }
        }
      }
    }
  `;

  async function paginate(query) {
    const all = [];
    let cursor = null;
    for (let page = 0; page < 6; page += 1) {
      const data = await shopifyAdminGraphql(query, { cursor });
      const connection = data?.products;
      const nodes = connection?.nodes || [];
      for (const node of nodes) {
        if (!node?.handle || !node?.title) continue;
        if (BLOCKED_HANDLES.has(node.handle)) continue;
        all.push(mapAdminProduct(node));
      }
      if (!connection?.pageInfo?.hasNextPage) break;
      cursor = connection.pageInfo.endCursor;
    }
    const seen = new Set();
    return all.filter((item) => {
      if (seen.has(item.handle)) return false;
      seen.add(item.handle);
      return true;
    });
  }

  try {
    return await paginate(queryWithInventory);
  } catch (err) {
    console.warn(
      "Admin catalog with inventory failed; retrying without inventoryQuantity:",
      err?.message || err
    );
    return paginate(queryWithoutInventory);
  }
}

function pickVariant(variants) {
  if (!Array.isArray(variants) || !variants.length) return null;
  return (
    variants.find((item) => item && item.available) ||
    variants[0] ||
    null
  );
}

function extractNotes(text) {
  const raw = String(text || "");
  const match = raw.match(
    /(?:notes?|accords?|olfactory)\s*[:\-–]\s*([^\n.]{3,120})/i
  );
  return match ? match[1].trim() : "";
}

function mapProduct(item, collectionTitles) {
  const variants = Array.isArray(item.variants) ? item.variants : [];
  const variant = pickVariant(variants);
  const price = variant?.price != null ? String(variant.price) : "";
  const compareAt =
    variant?.compare_at_price != null ? String(variant.compare_at_price) : "";
  const onSale =
    price && compareAt && Number(compareAt) > Number(price);
  const description = stripHtml(item.body_html || "");
  const handle = String(item.handle || "").trim();
  const image =
    item.images?.[0]?.src ||
    item.image?.src ||
    variant?.featured_image?.src ||
    "";

  return {
    title: String(item.title || "").trim(),
    handle,
    type: String(item.product_type || "").trim(),
    tags: Array.isArray(item.tags)
      ? item.tags.join(", ")
      : String(item.tags || ""),
    vendor: String(item.vendor || "").trim(),
    summary: description.slice(0, 220),
    description: description.slice(0, 500),
    notes: extractNotes(description),
    ingredients: "",
    longevity: "",
    gender: "",
    occasion: "",
    metafields: {},
    price,
    compare_at_price: onSale ? compareAt : "",
    available: variant ? Boolean(variant.available) : true,
    inventory_quantity: null,
    url: handle ? `https://${SHOP_DOMAIN}/products/${handle}` : "",
    image: String(image || ""),
    variants: variants.slice(0, 6).map((entry) => ({
      title: String(entry.title || "Default").trim(),
      price: entry.price != null ? String(entry.price) : "",
      compare_at_price:
        entry.compare_at_price != null ? String(entry.compare_at_price) : "",
      available: Boolean(entry.available),
      sku: String(entry.sku || ""),
    })),
    collections: Array.isArray(collectionTitles)
      ? collectionTitles.slice(0, 6)
      : [],
    source: "storefront",
  };
}

async function fetchProductPage(page) {
  const url = `https://${SHOP_DOMAIN}/products.json?limit=250&page=${page}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) return [];
  const data = await response.json();
  return data?.products || [];
}

async function loadCollectionTitles() {
  const now = Date.now();
  if (collectionsCache.map && now < collectionsCache.expiresAt) {
    return collectionsCache.map;
  }

  let titles = [];
  try {
    const response = await fetch(
      `https://${SHOP_DOMAIN}/collections.json?limit=250`,
      { headers: { Accept: "application/json" } }
    );
    if (response.ok) {
      const data = await response.json();
      titles = (data?.collections || [])
        .map((item) => String(item.title || "").trim())
        .filter(Boolean)
        .slice(0, 60);
    }
  } catch {
    titles = [];
  }

  collectionsCache = {
    map: titles,
    expiresAt: now + CATALOG_CACHE_TTL_MS,
  };
  return titles;
}

async function loadFullCatalog() {
  const now = Date.now();
  if (catalogCache.products && now < catalogCache.expiresAt) {
    return catalogCache.products;
  }

  // Prefer Admin API (Client Credentials) for metafields + accurate inventory.
  if (hasShopifyAdminAuth()) {
    try {
      const adminProducts = await loadCatalogFromAdmin();
      if (adminProducts.length) {
        catalogCache = {
          products: adminProducts,
          expiresAt: now + CATALOG_CACHE_TTL_MS,
        };
        console.log(
          `[catalog] Loaded ${adminProducts.length} products from Shopify Admin API`
        );
        return adminProducts;
      }
    } catch (err) {
      console.error(
        "Admin catalog failed, falling back to public products.json:",
        err?.message || err
      );
    }
  }

  const allProducts = [];
  const MAX_PAGES = 3;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await fetchProductPage(page);
    allProducts.push(...batch);
    if (batch.length < 250) break;
  }

  const collectionTitles = await loadCollectionTitles().catch(() => []);

  const seen = new Set();
  const unique = allProducts
    .filter((item) => {
      if (!item?.handle || !item?.title || BLOCKED_HANDLES.has(item.handle)) {
        return false;
      }
      if (seen.has(item.handle)) return false;
      seen.add(item.handle);
      return true;
    })
    .map((item) => {
      const mapped = mapProduct(item, []);
      const hay = `${mapped.title} ${mapped.type} ${mapped.tags}`.toLowerCase();
      mapped.collections = collectionTitles
        .filter((title) => {
          const words = title
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((w) => w.length >= 2); // include short brand tokens like "cn1"
          return words.some((word) => hay.includes(word));
        })
        .slice(0, 4);
      mapped.source = "storefront";
      return mapped;
    });

  catalogCache = {
    products: unique,
    expiresAt: now + CATALOG_CACHE_TTL_MS,
  };

  console.log(`[catalog] Loaded ${unique.length} products from public storefront`);
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
    "STORE POLICIES:",
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

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

/**
 * Create/update a Shopify customer from Step 2 email via Admin API.
 * Requires write_customers scope. Safe no-op if auth/scope is missing.
 */
async function ensureShopifyCustomer(email) {
  const cleaned = String(email || "").trim().toLowerCase();
  if (!isValidEmail(cleaned)) {
    return { ok: false, reason: "invalid_email" };
  }
  if (!hasShopifyAdminAuth()) {
    return { ok: false, reason: "missing_shopify_auth" };
  }

  const tags = ["AI Scent Finder", "email-marketing-consent", "newsletter"];
  const hint =
    "Ensure app scopes include write_customers + read_customers, release/install the app version, and enable Protected customer data access for Customer email.";

  async function setMarketingConsent(customerId) {
    try {
      const consent = await shopifyAdminGraphql(
        `mutation customerEmailMarketingConsentUpdate($input: CustomerEmailMarketingConsentUpdateInput!) {
          customerEmailMarketingConsentUpdate(input: $input) {
            customer { id }
            userErrors { field message }
          }
        }`,
        {
          input: {
            customerId,
            emailMarketingConsent: {
              marketingState: "SUBSCRIBED",
              marketingOptInLevel: "SINGLE_OPT_IN",
              consentUpdatedAt: new Date().toISOString(),
            },
          },
        }
      );
      const errors =
        consent?.customerEmailMarketingConsentUpdate?.userErrors || [];
      if (errors.length) {
        console.warn("marketing consent errors:", errors);
        return { ok: false, errors };
      }
      return { ok: true };
    } catch (err) {
      console.warn("marketing consent failed:", err?.message || err);
      return { ok: false, error: String(err?.message || err) };
    }
  }

  // 1) Prefer create first — needs write_customers only
  try {
    const created = await shopifyAdminGraphql(
      `mutation customerCreate($input: CustomerInput!) {
        customerCreate(input: $input) {
          customer { id email tags }
          userErrors { field message }
        }
      }`,
      {
        input: {
          email: cleaned,
          tags,
        },
      }
    );

    const createErrors = created?.customerCreate?.userErrors || [];
    const newCustomer = created?.customerCreate?.customer;
    if (newCustomer?.id && !createErrors.length) {
      await setMarketingConsent(newCustomer.id);
      return { ok: true, action: "created", id: newCustomer.id };
    }

    const emailTaken = createErrors.some((err) =>
      /already|taken|exists|has already been taken/i.test(
        String(err?.message || "")
      )
    );
    if (!emailTaken && createErrors.length) {
      return { ok: false, reason: "create_errors", errors: createErrors, hint };
    }
  } catch (err) {
    console.error("customerCreate exception:", err?.message || err);
  }

  // 2) Existing customer path — needs read_customers
  try {
    const existing = await shopifyAdminGraphql(
      `query CustomerByEmail($q: String!) {
        customers(first: 1, query: $q) {
          nodes { id email tags }
        }
      }`,
      { q: "email:" + cleaned }
    );

    const found = existing?.customers?.nodes?.[0];
    if (!found?.id) {
      return { ok: false, reason: "not_created_not_found", hint };
    }

    const mergedTags = Array.from(
      new Set(
        [...(found.tags || []), ...tags]
          .map((tag) => String(tag).trim())
          .filter(Boolean)
      )
    );

    const updated = await shopifyAdminGraphql(
      `mutation customerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer { id email tags }
          userErrors { field message }
        }
      }`,
      {
        input: {
          id: found.id,
          tags: mergedTags,
        },
      }
    );

    const updateErrors = updated?.customerUpdate?.userErrors || [];
    if (updateErrors.length) {
      return { ok: false, reason: "update_errors", errors: updateErrors, hint };
    }

    await setMarketingConsent(found.id);
    return {
      ok: true,
      action: "updated",
      id: updated?.customerUpdate?.customer?.id || found.id,
    };
  } catch (err) {
    console.error("ensureShopifyCustomer failed:", err?.message || err);
    return {
      ok: false,
      reason: "exception",
      error: String(err?.message || err),
      hint,
    };
  }
}

/**
 * Returns true if the code looks like a hex hash (random internal token)
 * or is marked as expired or is a Collabs/internal code.
 */
function isPublicCouponCode({ code, detail }) {
  const c = String(code || "").toUpperCase();
  const d = String(detail || "");

  // Reject pure hex hashes (32+ hex chars — internal Shopify tokens)
  if (/^[A-F0-9]{12,}$/.test(c)) return false;

  // Reject codes that contain 'EXPIRED' in code or detail
  if (/expired/i.test(c) || /expired/i.test(d)) return false;

  // Reject Shopify Collabs internal codes
  if (/collabs?/i.test(d)) return false;

  // Reject codes whose detail mentions it's an internal/ambassador/commission code
  if (/commission|ambassador|tier code|ugc/i.test(d)) return false;

  return true;
}

async function loadPublishedCoupons() {
  // Only expose codes that are explicitly whitelisted in SHOPIFY_DISCOUNT_INFO.
  // We deliberately do NOT fetch all codes from the Admin API to prevent
  // internal/influencer/collabs/subscriber codes from leaking to customers.
  const fromEnv = parsePublishedCoupons(process.env.SHOPIFY_DISCOUNT_INFO)
    .filter(isPublicCouponCode);
  return fromEnv;
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

// Maximum number of coupon codes shown to customers at once
const MAX_COUPONS_SHOWN = 3;

function buildFactualDiscountReply({ text, catalog, previousHandles, coupons }) {
  const product = findReferencedProduct(text, catalog, previousHandles);
  // Cap the number of codes shown to avoid overwhelming replies
  const published = (Array.isArray(coupons) ? coupons : []).slice(0, MAX_COUPONS_SHOWN);
  const hasCoupons = published.length > 0;

  // If no specific product is identified, ask the user which product they mean
  // rather than dumping all store coupons / sale items
  if (!product) {
    return {
      reply: hasCoupons
        ? `Which product are you asking about? Once you tell me the name, I can check its exact price, discount, and stock for you.`
        : "Which product are you asking about? Tell me the name and I'll check its current price and availability for you.",
      intent: "clarify",
      title: "",
      handle: "",
      bg_color: "#c9e2e8",
    };
  }

  if (product) {
    const onSale = productHasSale(product);
    const stockBit = product.available ? "In stock" : "Out of stock";
    if (onSale && hasCoupons) {
      const codes = published
        .map((item) => `${item.code} (${item.detail})`)
        .join("; ");
      return {
        reply: `Yes — ${product.title} is on sale at $${product.price} (was $${product.compare_at_price}). ${stockBit}. You can also use coupon code(s): ${codes}.`,
        intent: "recommend",
        title: product.title,
        handle: product.handle,
        bg_color: "#c4a07a",
      };
    }
    if (onSale) {
      return {
        reply: `Yes — ${product.title} is on sale at $${product.price} (was $${product.compare_at_price}). ${stockBit}. No additional coupon code needed.`,
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
        reply: `${product.title} is $${product.price} with no sale price right now. ${stockBit}. You can try coupon code(s): ${codes}.`,
        intent: "recommend",
        title: product.title,
        handle: product.handle,
        bg_color: "#c9e2e8",
      };
    }
    return {
      reply: `${product.title} is currently $${product.price || "priced as listed"} with no active discount. ${stockBit}.`,
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

function formatProductFact(item, index) {
  const saleBit = item.compare_at_price
    ? ` | compare_at: $${item.compare_at_price}`
    : "";
  const notesBit = item.notes ? ` | notes: ${item.notes}` : "";
  const ingredientsBit = item.ingredients
    ? ` | ingredients: ${item.ingredients}`
    : "";
  const longevityBit = item.longevity ? ` | longevity: ${item.longevity}` : "";
  const genderBit = item.gender ? ` | gender: ${item.gender}` : "";
  const occasionBit = item.occasion ? ` | occasion: ${item.occasion}` : "";
  const inventoryBit = ""; // inventory quantity intentionally hidden from users
  const collectionsBit = item.collections?.length
    ? ` | collections: ${item.collections.join(", ")}`
    : "";
  const variantsBit = item.variants?.length
    ? ` | variants: ${item.variants
        .map(
          (entry) =>
            `${entry.title} $${entry.price || "n/a"} (${
              entry.available ? "in stock" : "out of stock"
            })`
        )
        .join("; ")}`
    : "";
  const metafieldBits = item.metafields
    ? Object.entries(item.metafields)
        .filter(([key, value]) => value && !/(notes|ingredient|longevity|gender|occasion)/i.test(key))
        .slice(0, 8)
        .map(([key, value]) => `${key}=${String(value).slice(0, 80)}`)
        .join("; ")
    : "";

  return `${index + 1}. ${item.title} | handle: ${item.handle} | type: ${
    item.type || "product"
  } | tags: ${item.tags || "n/a"} | price: $${item.price || "n/a"}${saleBit} | available: ${
    item.available ? "yes" : "no"
  }${inventoryBit} | url: ${item.url || "n/a"}${notesBit}${ingredientsBit}${longevityBit}${genderBit}${occasionBit}${collectionsBit}${variantsBit}${
    metafieldBits ? ` | metafields: ${metafieldBits}` : ""
  } | description: ${item.description || item.summary || "n/a"}`;
}

function formatCatalog(catalog) {
  if (!catalog.length) return "LIVE CN1 CATALOG: no products available.";
  return [
    "LIVE CN1 CATALOG (recommend only from this list):",
    ...catalog.map((item, index) => formatProductFact(item, index)),
  ].join("\n");
}

function scoreProduct(product, terms) {
  const metafieldText = product.metafields
    ? Object.values(product.metafields).join(" ")
    : "";
  const hay = [
    product.title,
    product.handle,
    product.type,
    product.tags,
    product.summary,
    product.description,
    product.notes,
    product.ingredients,
    product.longevity,
    product.gender,
    product.occasion,
    metafieldText,
    (product.collections || []).join(" "),
  ]
    .join(" ")
    .toLowerCase();

  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    if (hay.includes(term)) score += term.length > 4 ? 3 : 2;
  }
  if (product.available) score += 1;
  if (product.compare_at_price) score += 0.5;
  return score;
}

function searchCatalog(catalog, searchTerms, text, limit = 12) {
  const terms = [
    ...(Array.isArray(searchTerms) ? searchTerms : []),
    ...String(text || "")
      .toLowerCase()
      .split(/[^a-z0-9$]+/)
      .filter((word) => word.length > 2),
  ]
    .map((term) => String(term || "").toLowerCase().trim())
    .filter(Boolean);

  const uniqueTerms = [...new Set(terms)].slice(0, 16);
  if (!uniqueTerms.length) return (catalog || []).slice(0, limit);

  return [...(catalog || [])]
    .map((product) => ({ product, score: scoreProduct(product, uniqueTerms) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => row.product);
}

function filterByBudget(catalog, text) {
  const match = String(text || "").match(
    /(?:under|below|less than|budget(?: of)?|max(?:imum)?)\s*\$?\s*(\d+(?:\.\d+)?)/i
  );
  if (!match) return catalog;
  const max = Number(match[1]);
  if (!Number.isFinite(max)) return catalog;
  return catalog.filter((item) => Number(item.price) > 0 && Number(item.price) <= max);
}

function classifyIntentHeuristic(text, previousHandles) {
  const value = String(text || "").trim();
  const lower = value.toLowerCase();

  if (!looksLikeScentQuery(value)) {
    return {
      query_type: "greeting",
      needs_catalog: false,
      needs_policies: false,
      needs_discounts: false,
      focus_previous: false,
      search_terms: [],
    };
  }

  const focusPrevious =
    /\b(this|that|it|the (?:one|product|perfume|scent)|previous|same one)\b/i.test(
      lower
    ) && previousHandles.length > 0;

  if (isDiscountQuestion(value)) {
    return {
      query_type: "discount",
      needs_catalog: true,
      needs_policies: false,
      needs_discounts: true,
      focus_previous: focusPrevious || previousHandles.length > 0,
      search_terms: [],
    };
  }

  if (/\b(ship(ping)?|delivery|how long.*arrive|tracking)\b/i.test(lower)) {
    return {
      query_type: "shipping",
      needs_catalog: false,
      needs_policies: true,
      needs_discounts: false,
      focus_previous: false,
      search_terms: [],
    };
  }

  if (/\b(return|refund|exchange|money back)\b/i.test(lower)) {
    return {
      query_type: "returns",
      needs_catalog: false,
      needs_policies: true,
      needs_discounts: false,
      focus_previous: false,
      search_terms: [],
    };
  }

  if (/\b(compare|difference|vs\.?|versus)\b/i.test(lower)) {
    return {
      query_type: "compare",
      needs_catalog: true,
      needs_policies: false,
      needs_discounts: false,
      focus_previous: focusPrevious,
      search_terms: lower.split(/[^a-z0-9]+/).filter((w) => w.length > 3).slice(0, 8),
    };
  }

  if (
    /\b(price|cost|how much|available|in stock|notes?|ingredients?|longevity|last|unisex|gender|similar|cheaper|another option|lighter|stronger)\b/i.test(
      lower
    )
  ) {
    return {
      query_type: "product_info",
      needs_catalog: true,
      needs_policies: false,
      needs_discounts: false,
      focus_previous: focusPrevious || previousHandles.length > 0,
      search_terms: lower.split(/[^a-z0-9]+/).filter((w) => w.length > 3).slice(0, 8),
    };
  }

  if (
    /\b(show|browse|list|display|all|see|give me|what are|show me|suggest|recommend|looking for|want|need|best for|everyday|date|summer|winter|fresh|citrus|vanilla|woody|floral|under\s*\$?\d+|should i buy|don'?t like|do not like|collection|originals?|classic|signature|exclusive)\b/i.test(
      lower
    )
  ) {
    return {
      query_type: "recommend",
      needs_catalog: true,
      needs_policies: false,
      needs_discounts: false,
      focus_previous: /\bsimilar to this\b/i.test(lower) || focusPrevious,
      search_terms: lower.split(/[^a-z0-9]+/).filter((w) => w.length >= 2).slice(0, 12),
    };
  }

  return {
    query_type: "chat",
    needs_catalog: true,
    needs_policies: false,
    needs_discounts: false,
    focus_previous: focusPrevious,
    search_terms: lower.split(/[^a-z0-9]+/).filter((w) => w.length >= 2).slice(0, 12),
  };
}

function normalizeClassification(data, text, previousHandles) {
  const fallback = classifyIntentHeuristic(text, previousHandles);
  if (!data || typeof data !== "object") return fallback;

  const allowed = [
    "greeting",
    "recommend",
    "product_info",
    "discount",
    "shipping",
    "returns",
    "compare",
    "chat",
    "off_topic",
  ];
  const queryType = allowed.includes(data.query_type)
    ? data.query_type
    : fallback.query_type;

  return {
    query_type: queryType,
    needs_catalog: Boolean(
      data.needs_catalog ??
        ["recommend", "product_info", "discount", "compare", "chat"].includes(
          queryType
        )
    ),
    needs_policies: Boolean(
      data.needs_policies ??
        ["shipping", "returns"].includes(queryType)
    ),
    needs_discounts: Boolean(
      data.needs_discounts ?? queryType === "discount"
    ),
    focus_previous: Boolean(data.focus_previous ?? fallback.focus_previous),
    search_terms: Array.isArray(data.search_terms)
      ? data.search_terms.map((term) => String(term || "").trim()).filter(Boolean).slice(0, 10)
      : fallback.search_terms,
  };
}

async function classifyIntent(openai, text, history, previousHandles) {
  const heuristic = classifyIntentHeuristic(text, previousHandles);
  // Skip model call for obvious greetings / discount (discount uses factual path).
  if (heuristic.query_type === "greeting" || heuristic.query_type === "discount") {
    return heuristic;
  }

  try {
    const historyLines = (history || [])
      .slice(-4)
      .map(
        (item) =>
          `${item.role === "assistant" ? "Concierge" : "Shopper"}: ${item.content}`
      )
      .join("\n");

    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0,
      max_tokens: 120,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: CLASSIFY_INSTRUCTIONS },
        {
          role: "user",
          content: [
            historyLines ? `Recent conversation:\n${historyLines}` : "",
            previousHandles.length
              ? `Recently recommended handles: ${previousHandles.join(", ")}`
              : "",
            `Shopper: ${text}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
    });

    return normalizeClassification(
      extractJson(completion.choices[0]?.message?.content),
      text,
      previousHandles
    );
  } catch (err) {
    console.error("Intent classify failed:", err?.message || err);
    return heuristic;
  }
}

async function gatherStoreData({
  classification,
  text,
  previousHandles,
}) {
  const facts = {
    catalog: [],
    focused: null,
    policies: "",
    coupons: [],
    discountFacts: "",
  };

  let catalog = [];
  if (classification.needs_catalog || classification.needs_discounts) {
    catalog = await loadFullCatalog().catch(() => []);
  }

  if (classification.needs_policies) {
    facts.policies = await loadStoreContext(catalog).catch(() => "");
  }

  if (classification.needs_discounts) {
    facts.coupons = await loadPublishedCoupons().catch(() => []);
    // Find the specific product being asked about
    const referencedProduct = findReferencedProduct(text, catalog, previousHandles);
    const discountLines = [];
    if (referencedProduct) {
      const onSale = productHasSale(referencedProduct);
      discountLines.push(
        onSale
          ? `${referencedProduct.title} IS on sale: current price $${referencedProduct.price} (was $${referencedProduct.compare_at_price})`
          : `${referencedProduct.title} is NOT on sale. Current price: $${referencedProduct.price}.`
      );
      discountLines.push(
        `Stock: ${referencedProduct.available ? "In stock" : "Out of stock"}`
      );
    } else {
      discountLines.push("No specific product identified from this message.");
    }
    if (facts.coupons.length) {
      discountLines.push(
        `Published coupon codes: ${facts.coupons
          .map((item) => `${item.code} (${item.detail})`)
          .join("; ")}`
      );
    } else {
      discountLines.push("Published coupon codes: none currently available.");
    }
    facts.discountFacts = discountLines.join("\n");
  }

  if (classification.needs_catalog) {
    // ── Collection-aware search ──────────────────────────────────────────────
    // If the user's query contains a known collection name (e.g. "CN1 Originals"),
    // inject ALL products from that collection first so the AI always sees them.
    const allCollectionNames = [...new Set(
      catalog.flatMap((p) => p.collections || [])
    )];
    const queryLower = text.toLowerCase();
    const matchedCollection = allCollectionNames.find((colName) => {
      const colLower = colName.toLowerCase();
      // Exact or contained match
      if (queryLower.includes(colLower)) return true;
      // All words of collection name appear in query
      const words = colLower.split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
      return words.length >= 2 && words.every((w) => queryLower.includes(w));
    });

    let collectionProducts = [];
    if (matchedCollection) {
      collectionProducts = catalog.filter((p) =>
        (p.collections || []).some(
          (c) => c.toLowerCase() === matchedCollection.toLowerCase()
        )
      );
      console.log(
        `[search] Collection "${matchedCollection}" matched: ${collectionProducts.length} products`
      );
    }

    // ── Regular keyword search ───────────────────────────────────────────────
    let matches = searchCatalog(
      catalog,
      classification.search_terms,
      text,
      classification.query_type === "compare" ? 8 : 14
    );
    matches = filterByBudget(matches.length ? matches : catalog, text);

    // Merge collection products at the front (deduplicated)
    if (collectionProducts.length) {
      const collectionHandles = new Set(collectionProducts.map((p) => p.handle));
      const nonCollectionMatches = matches.filter((p) => !collectionHandles.has(p.handle));
      matches = [...collectionProducts, ...nonCollectionMatches];
    }

    if (!matches.length && catalog.length) {
      matches = filterByBudget(catalog, text).slice(0, 14);
    }

    const focused = classification.focus_previous
      ? findReferencedProduct(text, catalog, previousHandles)
      : findReferencedProduct(text, catalog, []);

    if (focused && !matches.some((item) => item.handle === focused.handle)) {
      matches = [focused, ...matches].slice(0, 14);
    }

    // Keep previously discussed products available for follow-ups.
    for (const handle of [...previousHandles].reverse()) {
      const item = catalog.find((product) => product.handle === handle);
      if (item && !matches.some((row) => row.handle === item.handle)) {
        matches.push(item);
      }
    }

    // For collection browsing, pass more products to the AI (up to 20)
    const factsLimit = matchedCollection ? 20 : 14;
    facts.catalog = matches.slice(0, factsLimit);
    facts.focused = focused;

    if (matchedCollection) {
      facts.collectionHint = `User is browsing the "${matchedCollection}" collection. Show ALL ${collectionProducts.length} products from it.`;
    }
  }

  return facts;
}

function bindToCatalog(payload, catalog) {
  if (!catalog.length) {
    if (payload.intent === "recommend") {
      return {
        ...payload,
        intent: "chat",
        title: "",
        handle: "",
        products: [],
        reply:
          payload.reply ||
          "I could not verify that product in the live catalog right now. Ask me about a scent, product type, price, or shipping and I will help from store data.",
      };
    }
    return payload;
  }

  // Bind the products array entries to real catalog items
  const boundProducts = (payload.products || []).reduce((acc, item) => {
    const hMatch = catalog.find((p) => p.handle === item.handle);
    const tMatch = catalog.find(
      (p) => p.title.toLowerCase() === item.title.toLowerCase()
    );
    const found = hMatch || tMatch;
    if (found && !acc.some((a) => a.handle === found.handle)) {
      acc.push({ title: found.title, handle: found.handle });
    }
    return acc;
  }, []);

  // Bind single handle/title
  const handleMatch = catalog.find((item) => item.handle === payload.handle);
  const titleMatch = catalog.find(
    (item) =>
      item.title.toLowerCase() === String(payload.title || "").toLowerCase()
  );
  const match = handleMatch || titleMatch;

  // If we have valid bound products, return them
  if (boundProducts.length) {
    const primary = match || (boundProducts.length === 1 ? catalog.find(p => p.handle === boundProducts[0].handle) : null);
    return {
      ...payload,
      intent: "recommend",
      title: primary ? primary.title : "",
      handle: primary ? primary.handle : "",
      products: boundProducts,
    };
  }

  if (match) {
    return {
      ...payload,
      intent: "recommend",
      title: match.title,
      handle: match.handle,
      products: [{ title: match.title, handle: match.handle }],
    };
  }

  if (payload.intent === "recommend") {
    return {
      ...payload,
      intent: "chat",
      title: "",
      handle: "",
      products: [],
      reply:
        payload.reply ||
        "I could not find an exact catalog match for that. Tell me another product type, scent, or question about the store.",
    };
  }

  return { ...payload, title: "", handle: "", products: [] };
}

function buildAnswerPrompt({
  text,
  history,
  previousHandles,
  classification,
  storeFacts,
}) {
  const lines = [
    `Query type: ${classification.query_type}`,
    "",
    "STORE DATA FACTS (source of truth — do not invent beyond this):",
  ];

  // Collection browse hint — tells AI to list ALL products in the section
  if (storeFacts.collectionHint) {
    lines.push(`COLLECTION CONTEXT: ${storeFacts.collectionHint}`);
    lines.push("List every product in the Relevant Shopify products section as a recommendation. Do NOT say the collection does not exist.");
    lines.push("");
  }

  if (storeFacts.focused) {
    lines.push("Focused product:");
    lines.push(formatProductFact(storeFacts.focused, 0));
    lines.push("");
  }

  if (storeFacts.catalog?.length) {
    lines.push("Relevant Shopify products:");
    storeFacts.catalog.forEach((item, index) => {
      lines.push(formatProductFact(item, index));
    });
    lines.push("");
  } else if (classification.needs_catalog) {
    lines.push("Relevant Shopify products: none matched / catalog unavailable.");
    lines.push("");
  }

  if (storeFacts.discountFacts) {
    // Only show discount facts for the specific product being discussed
    lines.push("REAL DISCOUNT FACTS (for the specific product in context only):");
    lines.push(storeFacts.discountFacts);
    lines.push("Do NOT mention other products' prices or discounts unless explicitly asked.");
    lines.push("");
  }

  if (storeFacts.policies) {
    lines.push(storeFacts.policies);
    lines.push("");
  }

  if (!classification.needs_catalog && !classification.needs_policies && !classification.needs_discounts) {
    lines.push("No Shopify fetch required for this message.");
    lines.push("");
  }

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
      `Recently recommended product handles: ${previousHandles.join(", ")}`
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

/**
 * Fallback: scan AI reply text for product title mentions and build
 * the products array from catalog matches.
 * Used when the AI writes product names in text but omits the products JSON field.
 */
function extractProductsFromReply(reply, catalog) {
  const replyLower = String(reply || "").toLowerCase();
  const found = [];

  for (const product of catalog) {
    const title = String(product.title || "").toLowerCase();
    const handle = String(product.handle || "");
    if (!title || !handle || title.length < 3) continue;

    if (replyLower.includes(title)) {
      if (!found.some((p) => p.handle === handle)) {
        found.push({ title: product.title, handle });
      }
    }
  }

  return found;
}

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method === "GET") {
    const resolvedShop = await resolveShopifyShop().catch(() => getShopifyShop());
    return res.status(200).json({
      ok: true,
      service: "ai-scent-finder",
      max_asks: MAX_ASKS,
      window_hours: 24,
      max_input_words: MAX_INPUT_WORDS,
      history_limit: HISTORY_LIMIT,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      architecture: "openai-intent-then-shopify-facts",
      shopify_auth: hasShopifyClientCredentials()
        ? "client_credentials"
        : String(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "").trim()
          ? "static_admin_token"
          : "storefront_public_only",
      shopify_shop: resolvedShop || getShopifyShop() || null,
      shopify_shop_env: String(process.env.SHOPIFY_SHOP || "").trim() || null,
      storefront_domain: SHOP_DOMAIN,
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
  const customerEmail = String(body.email || "").trim().toLowerCase();

  // Must await on Vercel — fire-and-forget is frozen when the response ends.
  let customerSync = null;
  if (customerEmail) {
    customerSync = await ensureShopifyCustomer(customerEmail);
    if (!customerSync?.ok) {
      console.warn("Shopify customer sync skipped/failed:", customerSync);
    } else {
      console.log("Shopify customer sync:", customerSync.action, customerSync.id);
    }
  }

  sessionQuota.count += 1;
  if (ipQuota !== sessionQuota) ipQuota.count += 1;

  try {
    const openai = getOpenAIClient();

    // 1) OpenAI (or heuristic fallback) determines intent
    const classification = await classifyIntent(
      openai,
      text,
      history,
      previousHandles
    );

    // 2) Shopify only when store data is needed
    // Discount path stays factual to prevent invented coupon codes.
    if (classification.query_type === "discount" || isDiscountQuestion(text)) {
      const catalog = await loadFullCatalog().catch(() => []);
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
        customer_sync: customerSync,
      });
    }

    const storeFacts = await gatherStoreData({
      classification,
      text,
      previousHandles,
    });

    // 3) OpenAI generates the final answer from retrieved facts + history
    const prompt = buildAnswerPrompt({
      text,
      history,
      previousHandles,
      classification,
      storeFacts,
    });

    const bindPool = [
      ...(storeFacts.focused ? [storeFacts.focused] : []),
      ...(storeFacts.catalog || []),
    ];

    const rawPayload = normalizePayload(await recommend(openai, prompt));

    // Sanitize reply: strip markdown links, bold, URLs, handle/price lines
    rawPayload.reply = sanitizeReply(rawPayload.reply);

    // ── Fallback: extract products from reply text ──────────────────────────
    // If the AI wrote product names in the reply text but forgot the products
    // JSON array, scan the reply and auto-populate products from catalog.
    if (
      rawPayload.intent === "recommend" &&
      !rawPayload.products?.length &&
      rawPayload.reply &&
      bindPool.length
    ) {
      const extracted = extractProductsFromReply(rawPayload.reply, bindPool);
      if (extracted.length) {
        rawPayload.products = extracted;
        rawPayload.intent = "recommend"; // force recommend so cards render
        console.log(
          `[products] Extracted ${extracted.length} product(s) from reply text:`,
          extracted.map((p) => p.handle).join(", ")
        );
      }
    }

    const payload = bindToCatalog(rawPayload, bindPool);

    return res.status(200).json({
      ...payload,
      remaining: Math.max(0, MAX_ASKS - sessionQuota.count),
      customer_sync: customerSync,
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
  classifyIntentHeuristic,
  normalizeClassification,
  searchCatalog,
  filterByBudget,
  scoreProduct,
  hasShopifyClientCredentials,
  hasShopifyAdminAuth,
  getShopifyShop,
  metafieldMap,
  pickMetafield,
  mapAdminProduct,
  ensureShopifyCustomer,
  isValidEmail,
};
