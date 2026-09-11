/**
 * Cost-control limit tests for api/recommend.js
 * Run: node test/limits.test.js
 */
const assert = require("assert");
const handler = require("../api/recommend");
const t = handler._test;

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
  };
}

async function post(body, headers = {}) {
  const req = {
    method: "POST",
    headers: {
      "x-forwarded-for": headers.ip || "203.0.113.10",
      ...headers,
    },
    body,
  };
  const res = mockRes();
  await handler(req, res);
  return res;
}

function words(n) {
  return Array.from({ length: n }, (_, i) => "word" + i).join(" ");
}

async function run() {
  let passed = 0;

  // --- Constants ---
  assert.strictEqual(t.MAX_ASKS, 20, "daily free limit is 20");
  assert.strictEqual(t.WINDOW_MS, 24 * 60 * 60 * 1000, "window is 24 hours");
  assert.strictEqual(t.MAX_INPUT_WORDS, 800, "max input words is 800");
  assert.ok(t.HISTORY_LIMIT >= 6 && t.HISTORY_LIMIT <= 10, "history within 6–10");
  assert.ok(
    t.MAX_OUTPUT_TOKENS >= 300 && t.MAX_OUTPUT_TOKENS <= 500,
    "output tokens within 300–500"
  );
  assert.ok(
    t.DAILY_LIMIT_MESSAGE.includes("free chat limit for today"),
    "friendly daily limit message"
  );
  passed += 6;

  // --- Word counting ---
  assert.strictEqual(t.countWords(""), 0);
  assert.strictEqual(t.countWords("  hello world  "), 2);
  assert.strictEqual(t.countWords(words(800)), 800);
  assert.strictEqual(t.countWords(words(801)), 801);
  passed += 4;

  // --- cleanText char safety cap ---
  const long = "a".repeat(t.MAX_INPUT_CHARS + 100);
  assert.strictEqual(t.cleanText(long).length, t.MAX_INPUT_CHARS);
  passed += 1;

  // --- History window ---
  const history = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: "message " + i + " " + "x".repeat(400),
  }));
  const sanitized = t.sanitizeHistory(history);
  assert.strictEqual(sanitized.length, t.HISTORY_LIMIT);
  assert.ok(sanitized.every((m) => m.content.length <= t.HISTORY_CONTENT_CHARS));
  assert.strictEqual(sanitized[sanitized.length - 1].content.startsWith("message 19"), true);
  passed += 3;

  // --- Reject oversized messages (no OpenAI call) ---
  const tooLong = await post({
    text: words(801),
    session_id: "test-long-msg-1",
  });
  assert.strictEqual(tooLong.statusCode, 400);
  assert.strictEqual(tooLong.body.error, "message_too_long");
  passed += 2;

  // --- Empty input ---
  const empty = await post({ text: "   ", session_id: "test-empty-1" });
  assert.strictEqual(empty.statusCode, 400);
  assert.strictEqual(empty.body.error, "bad_input");
  passed += 2;

  // --- Daily session limit enforced server-side (cannot bypass via client) ---
  const sessionId = "bypass-test-session-" + Date.now();
  const sessionKey = "s:" + t.sanitizeSession(sessionId);
  const quota = t.getQuota(sessionKey);
  quota.count = t.MAX_ASKS; // simulate already used today's free messages

  const blocked = await post({
    text: "warm vanilla scent",
    session_id: sessionId,
  });
  assert.strictEqual(blocked.statusCode, 429);
  assert.strictEqual(blocked.body.error, "rate_limit_exceeded");
  assert.strictEqual(blocked.body.remaining, 0);
  assert.strictEqual(blocked.body.message, t.DAILY_LIMIT_MESSAGE);
  passed += 4;

  // --- Clearing / rotating session_id still hits IP ceiling after abuse ---
  const abuseIp = "198.51.100." + (Date.now() % 200);
  const ipKey = "ip:" + abuseIp;
  const ipQuota = t.getQuota(ipKey);
  ipQuota.count = t.MAX_ASKS_PER_IP;

  const ipBlocked = await post(
    {
      text: "fresh citrus perfume",
      session_id: "brand-new-session-" + Date.now(),
    },
    { ip: abuseIp }
  );
  assert.strictEqual(ipBlocked.statusCode, 429);
  assert.strictEqual(ipBlocked.body.remaining, 0);
  passed += 2;

  // --- GET health reports new limits ---
  const getReq = { method: "GET", headers: {} };
  const getRes = mockRes();
  await handler(getReq, getRes);
  assert.strictEqual(getRes.statusCode, 200);
  assert.strictEqual(getRes.body.max_asks, 20);
  assert.strictEqual(getRes.body.window_hours, 24);
  assert.strictEqual(getRes.body.max_input_words, 800);
  assert.strictEqual(getRes.body.history_limit, t.HISTORY_LIMIT);
  assert.strictEqual(getRes.body.max_output_tokens, t.MAX_OUTPUT_TOKENS);
  passed += 6;

  // --- Remaining math ---
  const mid = t.getQuota("s:remaining-check");
  mid.count = 7;
  assert.strictEqual(Math.max(0, t.MAX_ASKS - mid.count), 13);
  passed += 1;

  // --- Response-handling: answer store questions, no forced wrong product ---
  assert.ok(
    /Do NOT deflect with generic lines/i.test(t.SYSTEM_INSTRUCTIONS),
    "prompt forbids fragrance-only deflection"
  );
  assert.ok(
    /Discount \/ coupon questions/i.test(t.SYSTEM_INSTRUCTIONS),
    "prompt covers coupon questions"
  );
  assert.ok(
    /Product searches/i.test(t.SYSTEM_INSTRUCTIONS),
    "prompt covers product-category searches"
  );

  const sampleCatalog = [
    {
      title: "Floral Reverie Body Splash",
      handle: "floral-reverie-body-splash",
      type: "Women Body Mist",
      vendor: "CN1",
      tags: "",
      summary: "fresh floral body splash",
      price: "29.00",
      compare_at_price: "",
      available: true,
    },
    {
      title: "Amber Night",
      handle: "amber-night",
      type: "Perfume",
      vendor: "CN1",
      tags: "",
      summary: "warm amber",
      price: "39.00",
      compare_at_price: "49.00",
      available: true,
    },
  ];

  const missingProduct = t.bindToCatalog(
    {
      intent: "recommend",
      title: "Hand Lotion",
      handle: "hand-lotion",
      reply: "We do not currently carry hand lotion in the catalog.",
    },
    sampleCatalog
  );
  assert.strictEqual(missingProduct.intent, "chat");
  assert.strictEqual(missingProduct.handle, "");
  assert.ok(/hand lotion/i.test(missingProduct.reply));

  const foundProduct = t.bindToCatalog(
    {
      intent: "recommend",
      title: "Floral Reverie Body Splash",
      handle: "floral-reverie-body-splash",
      reply: "Yes — we have Floral Reverie Body Splash.",
    },
    sampleCatalog
  );
  assert.strictEqual(foundProduct.intent, "recommend");
  assert.strictEqual(foundProduct.handle, "floral-reverie-body-splash");

  const catalogText = t.formatCatalog(sampleCatalog);
  assert.ok(/price: \$29\.00/.test(catalogText));
  assert.ok(/sale was \$49\.00/.test(catalogText));
  assert.ok(/in stock/.test(catalogText));
  passed += 10;

  // --- Factual discount/coupon answers (no invented codes) ---
  assert.strictEqual(t.isDiscountQuestion("Is there any coupon code?"), true);
  assert.strictEqual(t.isDiscountQuestion("warm vanilla scent"), false);
  assert.deepStrictEqual(
    t.parsePublishedCoupons("WELCOME10: 10% off | SPRING5: $5 off"),
    [
      { code: "WELCOME10", detail: "10% off" },
      { code: "SPRING5", detail: "$5 off" },
    ]
  );
  assert.deepStrictEqual(t.parsePublishedCoupons(""), []);

  const saleCatalog = [
    {
      title: "Fusion",
      handle: "fusion",
      price: "54.40",
      compare_at_price: "64.00",
    },
    {
      title: "Amber Night",
      handle: "amber-night",
      price: "39.00",
      compare_at_price: "",
    },
  ];
  assert.strictEqual(t.productHasSale(saleCatalog[0]), true);
  assert.strictEqual(t.productHasSale(saleCatalog[1]), false);

  const saleReply = t.buildFactualDiscountReply({
    text: "Is there any discount for Fusion?",
    catalog: saleCatalog,
    previousHandles: [],
    coupons: [],
  });
  assert.ok(/Yes/i.test(saleReply.reply));
  assert.ok(/54\.40/.test(saleReply.reply));
  assert.ok(/no published coupon code/i.test(saleReply.reply));

  const noSaleReply = t.buildFactualDiscountReply({
    text: "any coupon for this product?",
    catalog: saleCatalog,
    previousHandles: ["amber-night"],
    coupons: [],
  });
  assert.ok(/^No/i.test(noSaleReply.reply));
  assert.ok(/Amber Night/.test(noSaleReply.reply));
  assert.ok(/no published coupon code/i.test(noSaleReply.reply));

  const withCode = t.buildFactualDiscountReply({
    text: "coupon code?",
    catalog: saleCatalog,
    previousHandles: [],
    coupons: [{ code: "SAVE10", detail: "10% off" }],
  });
  assert.ok(/SAVE10/.test(withCode.reply));
  passed += 12;

  console.log(`OK — ${passed} assertions passed`);
}

run().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
