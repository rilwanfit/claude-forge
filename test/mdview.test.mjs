import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, inline } from "../mdview.mjs";

test("common markdown renders: headings, emphasis, code, links, nested and task lists, tables", () => {
  const h = renderMarkdown("# Audit\n\nThe **checkout** retries on `500`. See [docs](https://example.com/a?b=1&c=2).\n\n- one\n  - nested\n- [x] done\n- [ ] todo\n\n1. first\n2. second\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1 < 2;\n```\n\n> **Note** careful", { highlight: false });
  assert.match(h, /<h2 class="md-h">Audit<\/h2>/); assert.match(h, /<strong>checkout<\/strong>/); assert.match(h, /<code>500<\/code>/);
  assert.match(h, /<a href="https:\/\/example.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs<\/a>/);
  assert.match(h, /<ul><li>one<ul><li>nested<\/li><\/ul><\/li>/); assert.match(h, /class="task done"/); assert.match(h, /class="task"/);
  assert.match(h, /<ol><li>first<\/li><li>second<\/li><\/ol>/); assert.match(h, /<th>a<\/th>/); assert.match(h, /<td>2<\/td>/);
  assert.match(h, /<pre class="md-code" data-lang="js"><code>const x = 1 &lt; 2;<\/code><\/pre>/); assert.match(h, /md-note/);
});

test("nothing in the source can run: html is escaped and only http(s) links become links", () => {
  const h = renderMarkdown('<img src=x onerror=alert(1)> [x](javascript:alert(1)) [y](data:text/html,hi) <script>bad()</script> `<b>` https://ok.example/path.', { highlight: false });
  assert.ok(!/<img|<script|onerror=.*>/.test(h.replace(/&lt;img[^]*?&gt;/g, "")), "no live tags");
  assert.ok(!/href="javascript|href="data/.test(h)); assert.match(h, /&lt;script&gt;/); assert.match(h, /<a href="https:\/\/ok.example\/path"/);
  assert.equal(inline("**a** <b>"), "<strong>a</strong> &lt;b&gt;");
});

test("a question is highlighted, and the options next to it become option cards", () => {
  const h = renderMarkdown("I found two ways:\n\n1. **Retry with backoff**: simple\n2. **Idempotency keys**: safer\n\nWhich approach should I take?");
  assert.match(h, /<aside class="md-ask">.*Needs your input.*Which approach should I take\?/s);
  assert.match(h, /<ol class="md-options">/);
});

test("a 'Decisions for you' section is highlighted as a whole, up to the next heading", () => {
  const h = renderMarkdown("## Done\n\nAll good.\n\n## Decisions for you\n\n- Keep Stripe?\n- Drop the old webhook?\n\n## Next\n\nLater.");
  assert.match(h, /<section class="md-ask md-ask-sec">.*Decisions for you.*Keep Stripe.*<\/section>/s);
  assert.ok(!/Later/.test(h.slice(0, h.indexOf("</section>"))), "the next section is outside the highlighted one");
  assert.match(h, /<\/section><h3 class="md-h">Next<\/h3>/);
});

test("only the last few questions are highlighted, and plain statements never are", () => {
  const q = (n) => `Is option ${n} fine?\n\n`;
  const h = renderMarkdown(q(1) + q(2) + q(3) + q(4) + q(5) + "All done.");
  assert.equal((h.match(/<aside class="md-ask">/g) || []).length, 3);
  assert.equal((renderMarkdown("Everything is fine. No questions.").match(/md-ask/g) || []).length, 0);
  assert.equal(renderMarkdown(""), "");
});
