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
  "reply": "natural customer-friendly answer (use short line breaks for product recommendations)",
  "intent": "recommend" | "clarify" | "chat",
  "title": "exact product title from STORE DATA FACTS, or empty string",
  "handle": "exact Shopify product handle from STORE DATA FACTS, or empty string",
  "bg_color": "#hex mood color"
}

Hard rules:
- Use ONLY STORE DATA FACTS and conversation history. Never invent product names, prices, coupons, stock, notes, ingredients, shipping, returns, or URLs.
- Prefer metafield values in STORE DATA FACTS for fragrance notes, ingredients, longevity, gender, and occasion when present.
- If a fact is missing from STORE DATA FACTS, say it is not currently available.
- Do NOT deflect with generic lines like "We specialize in fragrances..." — answer the question.
- When recommending, prefer this reply shape:
  Product Name
  Price: $XX
  Why I recommend it: ...
  Availability: In stock / Out of stock
  Then set intent to "recommend" with that product's exact title and handle.
- For follow-ups ("this one", "that perfume", "something cheaper"), use Focused product / Recently discussed products in the facts.
- Discount/coupon answers must match REAL DISCOUNT FACTS exactly. Never invent a code.
- If recommending an alternative, pick a different handle than ones already recommended when possible.
- Keep reply concise (about 40–90 words). bg_color mood defaults: warm #c4a07a, fresh #b7d6d4, floral #d8c2cc, night #c4b0aa, default #c9e2e8.`;

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

function getShopifyShop() {
  return String(process.env.SHOPIFY_SHOP || process.env.SHOPIFY_ADMIN_SHOP || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
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

  const shop = getShopifyShop();
  const clientId = String(process.env.SHOPIFY_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.SHOPIFY_CLIENT_SECRET || "").trim();

  if (clientId && clientSecret && shop) {
    const response = await fetch(
      `https://${shop}/admin/oauth/access_token`,
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
            .filter((w) => w.length > 3);
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

async function loadPublishedCoupons() {
  const fromEnv = parsePublishedCoupons(process.env.SHOPIFY_DISCOUNT_INFO);
  if (!hasShopifyAdminAuth() || !getShopifyShop()) return fromEnv;

  try {
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

    const data = await shopifyAdminGraphql(query);
    const nodes = data?.codeDiscountNodes?.nodes || [];
    const fromAdmin = [];
    for (const node of nodes) {
      const discount = node?.codeDiscount;
      if (!discount || String(discount.status || "").toUpperCase() !== "ACTIVE") {
        continue;
      }
      for (const entry of discount.codes?.nodes || []) {
        if (entry?.code) {
          fromAdmin.push({
            code: String(entry.code).toUpperCase(),
            detail: String(discount.title || "Active discount").trim(),
          });
        }
      }
    }

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
  const inventoryBit =
    item.inventory_quantity == null
      ? ""
      : ` | inventory_qty: ${item.inventory_quantity}`;
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
    /\b(suggest|recommend|looking for|want|need|best for|everyday|date|summer|winter|fresh|citrus|vanilla|woody|floral|under\s*\$?\d+|should i buy|don'?t like|do not like)\b/i.test(
      lower
    )
  ) {
    return {
      query_type: "recommend",
      needs_catalog: true,
      needs_policies: false,
      needs_discounts: false,
      focus_previous: /\bsimilar to this\b/i.test(lower) || focusPrevious,
      search_terms: lower.split(/[^a-z0-9]+/).filter((w) => w.length > 3).slice(0, 8),
    };
  }

  return {
    query_type: "chat",
    needs_catalog: true,
    needs_policies: false,
    needs_discounts: false,
    focus_previous: focusPrevious,
    search_terms: lower.split(/[^a-z0-9]+/).filter((w) => w.length > 3).slice(0, 8),
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
    const saleItems = catalog.filter(productHasSale).slice(0, 8);
    facts.discountFacts = [
      facts.coupons.length
        ? `Published coupon codes: ${facts.coupons
            .map((item) => `${item.code} (${item.detail})`)
            .join("; ")}`
        : "Published coupon codes: none found via configured Shopify discount data/API.",
      saleItems.length
        ? `Live sale prices: ${saleItems
            .map(
              (item) =>
                `${item.title} (handle: ${item.handle}) $${item.price} was $${item.compare_at_price}`
            )
            .join("; ")}`
        : "Live sale prices: none in catalog.",
    ].join("\n");
  }

  if (classification.needs_catalog) {
    let matches = searchCatalog(
      catalog,
      classification.search_terms,
      text,
      classification.query_type === "compare" ? 8 : 12
    );
    matches = filterByBudget(matches.length ? matches : catalog, text);

    if (!matches.length && catalog.length) {
      matches = filterByBudget(catalog, text).slice(0, 12);
    }

    const focused = classification.focus_previous
      ? findReferencedProduct(text, catalog, previousHandles)
      : findReferencedProduct(text, catalog, []);

    if (focused && !matches.some((item) => item.handle === focused.handle)) {
      matches = [focused, ...matches].slice(0, 12);
    }

    // Keep previously discussed products available for follow-ups.
    for (const handle of [...previousHandles].reverse()) {
      const item = catalog.find((product) => product.handle === handle);
      if (item && !matches.some((row) => row.handle === item.handle)) {
        matches.push(item);
      }
    }

    facts.catalog = matches.slice(0, 14);
    facts.focused = focused;
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
    lines.push("REAL DISCOUNT FACTS:");
    lines.push(storeFacts.discountFacts);
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
      architecture: "openai-intent-then-shopify-facts",
      shopify_auth: hasShopifyClientCredentials()
        ? "client_credentials"
        : String(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "").trim()
          ? "static_admin_token"
          : "storefront_public_only",
      shopify_shop: getShopifyShop() || null,
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
    const payload = bindToCatalog(
      normalizePayload(await recommend(openai, prompt)),
      bindPool
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
};
