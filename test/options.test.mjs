import test from "node:test";
import assert from "node:assert/strict";
import { suggestOptions } from "../lib/options.mjs";

const labels = (o) => o.map((x) => x.label);

test("Claude's own AskUserQuestion options win", () => {
  assert.deepEqual(suggestOptions("anything?", ["anything?"], ["Stripe", "Mollie"]), [{ label: "Stripe", value: "Stripe" }, { label: "Mollie", value: "Mollie" }]);
});

test("a numbered list before the question becomes options that name the number", () => {
  const o = suggestOptions("I found two ways:\n1. **Retry with backoff** — simple, adds latency\n2. **Idempotency keys** — safer, needs a migration\n\nWhich should I do?", ["Which should I do?"]);
  assert.deepEqual(labels(o), ["Retry with backoff", "Idempotency keys"]);
  assert.equal(o[1].value, "Option 2: Idempotency keys");
});

test("a bullet list after the question works, and lettered options keep their letter", () => {
  assert.deepEqual(labels(suggestOptions("Which database?\n- Postgres\n- SQLite\n- MySQL", ["Which database?"])), ["Postgres", "SQLite", "MySQL"]);
  assert.equal(suggestOptions("Pick one?\n(a) Fast path\n(b) Safe path", ["Pick one?"])[0].value, "Option A: Fast path");
});

test("'A or B?' in one sentence, and yes/no questions", () => {
  assert.deepEqual(labels(suggestOptions("", ["Should I use Stripe or Mollie?"])), ["Stripe", "Mollie"]);
  assert.deepEqual(labels(suggestOptions("Audit finished.\nShould I open an issue for the retry bug?", ["Should I open an issue for the retry bug?"])), ["Yes, go ahead", "No, don't"]);
});

test("open questions get no buttons (the text box is the answer)", () => {
  assert.deepEqual(suggestOptions("Which three competitors should I compare?", ["Which three competitors should I compare?"]), []);
  assert.deepEqual(suggestOptions("", []), []);
});

test("a long list is not offered as buttons", () => {
  assert.deepEqual(suggestOptions("Files:\n- a\n- b\n- c\n- d\n- e\n- f\n- g\nDelete them?", ["Delete them?"]).length, 2, "falls back to yes/no instead of 7 buttons");
});
