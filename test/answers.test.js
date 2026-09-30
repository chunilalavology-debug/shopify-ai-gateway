/**
 * Ingredient and best-seller answer checks.
 * Run: node test/answers.test.js
 */
const assert = require("assert");
const handler = require("../api/recommend");
const t = handler._test;

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader() {},
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

async function post(text) {
  const req = {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.55" },
    body: {
      text,
      session_id: "answer-check-" + text.slice(0, 12),
    },
  };
  const res = mockRes();
  await handler(req, res);
  return res;
}

function fixture(partial) {
  return {
    title: partial.title,
    handle: partial.handle,
    type: partial.type || "Perfume",
    tags: partial.tags || "",
    summary: partial.summary || "",
    description: partial.description || "",
    notes: partial.notes || "",
    ingredients: partial.ingredients || "",
    metafields: partial.metafields || {},
    collections: partial.collections || [],
    available: partial.available !== false,
    compare_at_price: partial.compare_at_price || "",
    price: partial.price || "40.00",
  };
}

async function run() {
  const decoy = fixture({
    title: "Plain Musk",
    handle: "plain-musk",
    description:
      "A fragrance with a soft musk ingredient and nothing else.",
  });
  const sandalwood = fixture({
    title: "Evening Wood",
    handle: "evening-wood",
    description: "Warm woods with sandalwood and amber.",
    ingredients: "sandalwood, amber",
  });
  const watermelon = fixture({
    title: "Watermelon Splash",
    handle: "watermelon-splash",
    description: "Juicy watermelon fragrance.",
  });

  const genericQuery =
    "Show me a fragrance with sandalwood ingredient";
  const ranked = t.searchCatalog(
    [decoy, sandalwood],
    [],
    genericQuery,
    5
  );
  assert.deepStrictEqual(
    ranked.map((item) => item.handle),
    ["evening-wood"],
    "generic words must not outrank the real ingredient"
  );

  assert.strictEqual(
    t.isBestsellerQuestion(
      "sabse jyada bikne wala product konsa hai"
    ),
    true
  );
  assert.strictEqual(
    t.isBestsellerQuestion("Which is your best selling product?"),
    true
  );
  assert.strictEqual(
    t.isBestsellerQuestion("What is the top seller for the season?"),
    true
  );
  assert.strictEqual(
    t.isBestsellerQuestion("best selling sandalwood perfume"),
    false
  );
  assert.strictEqual(
    t.isBestsellerQuestion("what is the second top seller"),
    true
  );
  assert.strictEqual(
    t.isBestsellerQuestion("second top selling product kon hai"),
    true
  );
  assert.strictEqual(
    t.isBestsellerQuestion("second to selling product kon hai"),
    true
  );
  assert.strictEqual(
    t.isBestsellerQuestion("what is the 2nd best selling product"),
    true
  );
  assert.strictEqual(
    t.isBestsellerQuestion("second best selling sandalwood"),
    false
  );

  const salesList = [
    { title: "Vanilla Harmony", handle: "vanilla-harmony", type: "Women" },
    { title: "Bliss Apple", handle: "bliss-apple", type: "Unisex" },
    { title: "Smoky Velvet", handle: "smoky-velvet", type: "Men" },
  ];
  const secondSeller = t.buildFactualBestsellerReply(
    "what is the second top seller",
    salesList
  );
  assert.strictEqual(secondSeller.products.length, 1);
  assert.strictEqual(secondSeller.products[0].handle, "bliss-apple");
  assert.match(secondSeller.reply, /Bliss Apple is our second top seller/i);
  const topSellerReply = t.buildFactualBestsellerReply(
    "what is the top seller",
    salesList
  );
  assert.strictEqual(topSellerReply.products[0].handle, "vanilla-harmony");

  const titleOnlyWoods = fixture({
    title: "Regal Woods",
    handle: "regal-woods",
    description: "Opens with bergamot and juniper berry.",
  });
  const realWoody = fixture({
    title: "Regal Woods",
    handle: "regal-woods",
    tags: "Woody",
    description: "Warm cardamom and cedarwood, with vetiver and amber.",
  });
  assert.strictEqual(
    t.searchByIngredients(
      [titleOnlyWoods],
      ["woody"]
    ).length,
    0,
    "a title that says Woods is not a woody note"
  );
  assert.strictEqual(t.noMatchReply().no_match, true);
  assert.match(
    t.noMatchReply().reply,
    /if you'd like, i can suggest/i
  );
  assert.strictEqual(t.isSuggestionYes("yes"), true);
  assert.strictEqual(t.isSuggestionYes("haan"), true);
  assert.strictEqual(
    t.lastReplyOfferedSuggestion([
      { role: "assistant", content: t.noMatchReply().reply },
    ]),
    true
  );
  assert.strictEqual(t.isSuggestionYes("woody notes please"), false);
  assert.strictEqual(
    t.searchByIngredients(
      [realWoody],
      ["woody"]
    )[0].handle,
    "regal-woods"
  );
  assert.deepStrictEqual(
    t.extractIngredientQuery(
      "I want something like woody notes in it"
    ),
    ["woody"]
  );

  const ingredientTerms = t.extractIngredientQuery(genericQuery);
  assert.deepStrictEqual(ingredientTerms, ["sandalwood"]);
  const fixtureReply = t.buildFactualIngredientReply(
    ingredientTerms,
    t.searchByIngredients(
      [decoy, sandalwood, watermelon],
      ingredientTerms
    )
  );
  assert.strictEqual(fixtureReply.products.length, 1);
  assert.strictEqual(fixtureReply.products[0].handle, "evening-wood");
  assert.strictEqual(fixtureReply.exact_match, true);

  console.log("Live catalog: watermelon ingredient");
  const melon = await post(
    "Show me a fragrance with watermelon ingredient"
  );
  assert.strictEqual(melon.statusCode, 200);
  assert.strictEqual(melon.body.exact_match, true);
  assert.ok(
    melon.body.products.some(
      (item) => item.handle === "watermelon-splash"
    ),
    "expected Watermelon Splash, got " +
      JSON.stringify(melon.body.products)
  );
  const catalogRes = await fetch(
    "https://www.cn1fragrance.com/products.json?limit=250&page=1"
  );
  const catalogJson = await catalogRes.json();
  const byHandle = new Map(
    (catalogJson.products || []).map((item) => [item.handle, item])
  );

  function listsTerm(handle, term) {
    const product = byHandle.get(handle);
    const hay = (
      (product?.title || "") +
      " " +
      String(product?.body_html || "").replace(/<[^>]+>/g, " ") +
      " " +
      (product?.tags || []).join(" ")
    ).toLowerCase();
    return new RegExp("\\b" + term + "s?\\b", "i").test(hay);
  }

  assert.ok(
    melon.body.products.every((item) =>
      listsTerm(item.handle, "watermelon")
    ),
    "a product without watermelon was returned: " +
      JSON.stringify(melon.body.products)
  );
  console.log(melon.body.reply);

  console.log("Live catalog: sandalwood ingredient");
  const wood = await post(genericQuery);
  assert.strictEqual(wood.statusCode, 200);
  assert.ok(wood.body.products.length > 0, wood.body.reply);
  assert.ok(
    wood.body.products.every((item) =>
      listsTerm(item.handle, "sandalwood")
    ),
    "a product that does not list sandalwood was returned: " +
      JSON.stringify(wood.body.products)
  );
  console.log(
    wood.body.products.map((item) => item.title).join(" | ")
  );
  console.log(wood.body.reply);

  console.log("Live catalog: missing ingredient");
  const missing = await post(
    "Show me a fragrance with zzzincense ingredient"
  );
  assert.strictEqual(missing.body.exact_match, true);
  assert.strictEqual(missing.body.products.length, 0);
  assert.strictEqual(missing.body.no_match, true);
  assert.match(missing.body.reply, /if you'd like, i can suggest/i);
  console.log(missing.body.reply);

  console.log("Live catalog: best seller without admin credentials");
  const best = await post(
    "sabse jyada bikne wala product konsa hai"
  );
  assert.strictEqual(best.statusCode, 200);
  assert.strictEqual(best.body.exact_match, true);
  assert.strictEqual(best.body.products.length, 0);
  assert.match(best.body.reply, /order sales/i);
  console.log(best.body.reply);

  const bestEnglish = await post(
    "Which is your best selling product?"
  );
  assert.strictEqual(bestEnglish.body.products.length, 0);
  assert.match(bestEnglish.body.reply, /order sales/i);
  console.log(bestEnglish.body.reply);

  console.log("OK — ingredient and best-seller answers matched the live catalog");
}

run().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
