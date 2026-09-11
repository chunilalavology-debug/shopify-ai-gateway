const t = require("../api/recommend")._test;

const cases = [
  "Please suggest a perfume for everyday use.",
  "I want something fresh and citrusy.",
  "Which perfume is best for a date night?",
  "What are the notes of this perfume?",
  "How long does this perfume last?",
  "How much does this perfume cost?",
  "Is this product available?",
  "Is there any coupon code available or any discount on this product?",
  "Do you have anything similar but cheaper?",
  "Compare these two perfumes.",
  "Which perfume is best for summer?",
  "I don't like strong fragrances. What should I buy?",
  "Do you have anything under $100?",
  "Is this perfume unisex?",
  "Can you recommend something similar to this one?",
];

for (const q of cases) {
  const c = t.classifyIntentHeuristic(q, ["amber-night"]);
  console.log(
    String(c.query_type).padEnd(13),
    "catalog=" + c.needs_catalog,
    "focus=" + c.focus_previous,
    "|",
    q.slice(0, 52)
  );
}
