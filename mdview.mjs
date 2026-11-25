// Renders Claude's messages as readable HTML and highlights what needs YOU: questions, "Decisions for you" sections, option lists.
// Everything is escaped before it is turned into markup: no HTML in the source ever runs, and links must be http(s).
// Used by the pages (served at /mdview.mjs) and by the tests.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ASK_HEADING = /(decisions?|decide|for you|needs? (your|you)|your (call|input|answer|decision)|open questions?|questions?|waiting (on|for) you|to confirm|still open|pending|action required|blocked)/i;
const ASK_PHRASE = /\b(should i|shall i|may i|do you want|would you like|let me know|tell me (which|whether|if)|your call|which (one|option)|can you (confirm|run|check))\b/i;
const MAX_HIGHLIGHTS = 3;

const safeHref = (u) => { try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? x.href : null; } catch { return null; } };
const plain = (s) => String(s).replace(/`([^`]*)`/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/(\*\*|__|~~|\*|_)/g, "").trim();
// A question mark inside a closing quote ('..."?' is fine, '...?"' is a quoted line) does not count: quoted copy is not an ask.
const isQuestion = (s) => { const t = plain(s).replace(/[)\]]+$/, ""); return /\?$/.test(t) || (ASK_PHRASE.test(t) && /\?\s*[)\]]*$/.test(t)); };
const SENT = /(?<=[.!?…])\s+(?=[A-Z"“'(\[*`_]|\d)/;
const AUX = /^(do|does|did|should|shall|can|could|would|will|is|are|was|were|may|might|want me|which|what|how|when|where|who|why|any|anything)\b/i;
/** Splits a paragraph at its final question: { lead, ask } where ask runs from the question to the end. null when it asks nothing. */
function askSplit(raw) {
  const sents = String(raw).split(SENT);
  const asks = (x) => isQuestion(x) && (ASK_PHRASE.test(x) || AUX.test(plain(x)) || x === sents[sents.length - 1]);
  let last = -1; for (let i = sents.length - 1; i >= 0; i--) if (asks(sents[i])) { last = i; break; }
  if (last < 0) return null;
  let start = last; while (start > 0 && isQuestion(sents[start - 1])) start--; // consecutive questions belong together
  return { lead: sents.slice(0, start).join(" "), ask: sents.slice(start).join(" ") };
}

export function inline(src) {
  const codes = [];
  let t = String(src).replace(/`([^`\n]+)`/g, (m, c) => `\u0000${codes.push(c) - 1}\u0000`);
  t = esc(t);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, url) => { const u = safeHref(url.replace(/&amp;/g, "&")); return u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${txt}</a>` : txt; });
  t = t.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, (m, pre, url) => { const u = safeHref(url.replace(/&amp;/g, "&")); return u ? `${pre}<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${url}</a>` : m; });
  t = t.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "<strong>$1</strong>").replace(/__(?=\S)(.+?)(?<=\S)__/g, "<strong>$1</strong>").replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "<del>$1</del>")
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*(?![*\w])/g, "$1<em>$2</em>").replace(/(^|[^_\w])_(?=[^\s_])([^_]+?)(?<=[^\s_])_(?![_\w])/g, "$1<em>$2</em>");
  return t.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${esc(codes[Number(i)])}</code>`).replace(/\n/g, "<br>");
}

const LI = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
function parseList(lines, i) {
  const items = []; let j = i;
  while (j < lines.length) {
    const l = lines[j], m = LI.exec(l);
    if (m) {
      const indent = m[1].replace(/\t/g, "  ").length, ordered = /\d/.test(m[2]);
      if (items.length && indent <= items[0].indent && ordered !== items[0].ordered) break; // a numbered list right after a bullet list is a new list
      items.push({ indent, ordered, text: m[3], children: [] }); j++; continue;
    }
    if (!l.trim()) { if (j + 1 < lines.length && LI.test(lines[j + 1])) { j++; continue; } break; }
    if (/^\s{2,}\S/.test(l) && items.length) { items.at(-1).text += "\n" + l.trim(); j++; continue; }
    break;
  }
  const root = { children: [] }, stack = [{ indent: -1, node: root }];
  for (const it of items) { while (stack.at(-1).indent >= it.indent) stack.pop(); stack.at(-1).node.children.push(it); stack.push({ indent: it.indent, node: it }); }
  const render = (list, mark) => { if (!list.length) return ""; const tag = list[0].ordered ? "ol" : "ul"; return `<${tag}>${list.map((it) => { const task = /^\[([ xX])\]\s+/.exec(it.text); const body = task ? it.text.slice(task[0].length) : it.text; const cls = [task ? "task" + (task[1] !== " " ? " done" : "") : "", mark?.(body) ? "md-q" : ""].filter(Boolean).join(" "); return `<li${cls ? ` class="${cls}"` : ""}>${task ? `<span class="box" aria-hidden="true">${task[1] !== " " ? "✓" : ""}</span>` : ""}${inline(body)}${render(it.children)}</li>`; }).join("")}</${tag}>`; };
  const top = root.children;
  return { html: render(top), texts: top.map((x) => x.text), count: top.length, ordered: top[0]?.ordered, next: j, renderMarked: (mark) => render(top, mark) };
}

function blocksOf(src) {
  const lines = String(src).replace(/\r/g, "").split("\n"), blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const fence = /^\s*(```|~~~)\s*([\w+#.-]*)/.exec(l);
    if (fence) { const buf = []; for (i++; i < lines.length && !/^\s*(```|~~~)/.test(lines[i]); i++) buf.push(lines[i]); blocks.push({ type: "code", html: `<pre class="md-code"${fence[2] ? ` data-lang="${esc(fence[2])}"` : ""}><code>${esc(buf.join("\n"))}</code></pre>` }); continue; }
    const h = /^(#{1,6})\s+(.*?)\s*#*$/.exec(l);
    if (h) { blocks.push({ type: "h", level: Math.min(h[1].length, 4), text: plain(h[2]), html: `<h${Math.min(h[1].length + 1, 5)} class="md-h">${inline(h[2])}</h${Math.min(h[1].length + 1, 5)}>` }); continue; }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(l)) { blocks.push({ type: "hr", html: "<hr>" }); continue; }
    if (l.includes("|") && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1] || "")) {
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(l), rows = []; for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) rows.push(cells(lines[i])); i--;
      blocks.push({ type: "table", html: `<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` }); continue;
    }
    if (/^\s*>/.test(l)) { const buf = []; for (; i < lines.length && /^\s*>/.test(lines[i]); i++) buf.push(lines[i].replace(/^\s*>\s?/, "")); i--; const inner = buf.join("\n"); const kind = /^\s*(\*\*)?(note|tip|important|warning|caution)\b/i.exec(inner)?.[2]?.toLowerCase(); blocks.push({ type: "quote", html: `<blockquote class="md-quote${kind ? " md-" + (kind === "caution" ? "warning" : kind) : ""}">${renderBlocks(inner, false)}</blockquote>` }); continue; }
    if (LI.test(l)) { const r = parseList(lines, i); i = r.next - 1; blocks.push({ type: "list", html: r.html, texts: r.texts, count: r.count, ordered: r.ordered, renderMarked: r.renderMarked }); continue; }
    if (!l.trim()) continue;
    const buf = [l]; while (i + 1 < lines.length && lines[i + 1].trim() && !/^(\s*(```|~~~)|#{1,6}\s|\s*>|\s*([-*+]|\d{1,3}[.)])\s)/.test(lines[i + 1])) buf.push(lines[++i]);
    blocks.push({ type: "p", text: buf.join(" "), split: null, html: `<p>${inline(buf.join("\n"))}</p>` });
  }
  return blocks;
}

const label = `<span class="md-ask-label"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>Needs your input</span>`;

function renderBlocks(src, highlight) {
  const blocks = blocksOf(src);
  if (!highlight) return blocks.map((b) => b.html).join("");
  // 1. sections under a heading like "Decisions for you" are asks as a whole
  const out = []; let section = null;
  const flush = () => { if (section) { out.push({ type: "ask-sec", html: `<section class="md-ask md-ask-sec">${label}${section.join("")}</section>` }); section = null; } };
  let askLevel = 0;
  for (const b of blocks) {
    if (b.type === "h") { if (section && b.level <= askLevel) flush(); if (!section && ASK_HEADING.test(b.text) && b.text.length < 80) { section = [b.html]; askLevel = b.level; continue; } }
    if (section) section.push(b.type === "list" && b.count >= 2 && b.count <= 8 ? b.html.replace(/^<(ul|ol)>/, '<$1 class="md-options">') : b.html); else out.push(b);
  }
  flush();
  // 2. questions elsewhere: only the last few are marked, so a long message is not a wall of highlights
  for (const b of out) if (b.type === "p") b.split = askSplit(b.text);
  const qIdx = out.map((b, i) => ((b.type === "p" && b.split) || (b.type === "list" && b.texts.some((t) => isQuestion(t))) ? i : -1)).filter((i) => i >= 0).slice(-MAX_HIGHLIGHTS);
  const set = new Set(qIdx);
  return out.map((b, i) => {
    if (set.has(i)) {
      if (b.type === "p" && b.split?.lead) return `<p>${inline(b.split.lead)}</p><aside class="md-ask">${label}<p>${inline(b.split.ask)}</p></aside>`; // only the question is marked, not the explanation before it
      if (b.type === "p") return `<aside class="md-ask">${label}<p>${inline(b.split ? b.split.ask : b.text)}</p></aside>`;
      if (b.type === "list") return `<div class="md-asklist">${label}${b.renderMarked(isQuestion)}</div>`; // only the question items are marked, the rest of the list stays plain
      return `<aside class="md-ask">${label}${b.html}</aside>`;
    }
    const near = set.has(i - 1) || set.has(i + 1);
    if (b.type === "list" && near && b.count >= 2 && b.count <= 8) return b.html.replace(/^<(ul|ol)>/, '<$1 class="md-options">');
    return b.html;
  }).join("");
}

/** Markdown to safe HTML. With highlight (default), what needs your answer is marked. */
export function renderMarkdown(src, { highlight = true } = {}) {
  const t = String(src ?? "").slice(0, 60_000); if (!t.trim()) return "";
  return `<div class="md">${renderBlocks(t, highlight)}</div>`;
}
