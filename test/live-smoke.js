/**
 * Live API smoke tests against production Vercel gateway.
 * Run: node test/live-smoke.js
 */
const ENDPOINT =
  process.env.AI_ENDPOINT ||
  "https://shopify-ai-gateway-rosy.vercel.app/api/recommend";

const sessionId = "live-smoke-" + Date.now();

async function post(body) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      session_id: sessionId,
      email: "smoke-test@example.com",
      history: body.history || [],
      previous_handles: body.previous_handles || [],
      text: body.text,
    }),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function run() {
  console.log("Endpoint:", ENDPOINT);

  const health = await fetch(ENDPOINT).then((r) => r.json());
  console.log("GET health:", JSON.stringify(health));
  assert(health.ok === true, "health ok");
  assert(
    health.shopify_auth === "client_credentials",
    "expected client_credentials auth, got " + health.shopify_auth
  );
  assert(health.shopify_shop === "cn1fragrance.myshopify.com", "shop mismatch");

  const cases = [
    {
      name: "everyday recommend",
      text: "Please suggest a perfume for everyday use.",
      expectRecommendOrChat: true,
    },
    {
      name: "citrus recommend",
      text: "I want something fresh and citrusy.",
      expectRecommendOrChat: true,
    },
    {
      name: "discount no product",
      text: "Is there any coupon code available?",
      expectDiscountish: true,
    },
  ];

  let lastHandle = "";
  let history = [];

  for (const testCase of cases) {
    const result = await post({
      text: testCase.text,
      history,
      previous_handles: lastHandle ? [lastHandle] : [],
    });
    console.log("\n---", testCase.name, "status", result.status);
    console.log("intent:", result.data.intent);
    console.log("title/handle:", result.data.title, "/", result.data.handle);
    console.log("reply:", String(result.data.reply || "").slice(0, 280));
    assert(result.status === 200, testCase.name + " HTTP " + result.status);
    assert(result.data.reply, testCase.name + " missing reply");
    assert(
      !/we specialize in fragrances/i.test(result.data.reply || ""),
      testCase.name + " generic deflection"
    );
    if (result.data.handle) lastHandle = result.data.handle;
    history.push({ role: "user", content: testCase.text });
    history.push({ role: "assistant", content: result.data.reply });
  }

  // Follow-up about previous product
  if (lastHandle) {
    const follow = await post({
      text: "How much does this perfume cost?",
      history: history.slice(-4),
      previous_handles: [lastHandle],
    });
    console.log("\n--- follow-up price status", follow.status);
    console.log("reply:", String(follow.data.reply || "").slice(0, 280));
    assert(follow.status === 200, "follow-up HTTP");
    assert(follow.data.reply, "follow-up reply");

    const discountFollow = await post({
      text: "Is there any discount on this product?",
      history: history.slice(-4),
      previous_handles: [lastHandle],
    });
    console.log("\n--- follow-up discount status", discountFollow.status);
    console.log("reply:", String(discountFollow.data.reply || "").slice(0, 280));
    assert(discountFollow.status === 200, "discount follow HTTP");
    assert(discountFollow.data.reply, "discount follow reply");
    assert(
      !/SAVE\d+|FAKE|invent/i.test(discountFollow.data.reply) ||
        /no published coupon|no active|no —|currently/i.test(
          discountFollow.data.reply
        ),
      "discount reply looks invented"
    );
  }

  // Empty / too long guards
  const empty = await post({ text: "   " });
  assert(empty.status === 400, "empty should 400");

  console.log("\nOK — live smoke tests passed");
}

run().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
