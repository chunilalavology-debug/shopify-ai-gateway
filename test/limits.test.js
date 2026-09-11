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

  console.log(`OK — ${passed} assertions passed`);
}

run().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
