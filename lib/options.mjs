// Suggested answers for a question Claude asked: its own options when it used AskUserQuestion, else a list or "A or B" found in the text, else Yes / No.
// Every suggestion is { label, value }: the label is the button, the value is what gets sent as the reply.
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const plain = (s) => s.replace(/\*\*|__|`|\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/^[>\s]+/, "").trim();
const ITEM = /^\s*(?:(\d{1,2})[.)]|\(?([a-eA-E])[.)]|[-*•])\s+(.+)$/;

const short = (text) => { const t = plain(text); const cut = t.split(/\s[—–-]\s|:\s/)[0]; return clip(cut.length >= 3 ? cut : t, 80); };

/** list items within a few lines of the last question */
function listNear(lines, qi) {
  const grab = (from, step) => { const out = []; for (let i = from; i >= 0 && i < lines.length && Math.abs(i - from) < 14; i += step) { const raw = lines[i]; if (!raw.trim()) { if (out.length) break; continue; } const m = ITEM.exec(raw); if (m) out.push({ n: m[1] || (m[2] ? m[2].toUpperCase() : null), text: m[3] }); else if (out.length) break; else if (step < 0 && Math.abs(i - from) > 2) break; } return step < 0 ? out.reverse() : out; };
  const after = grab(qi + 1, 1), before = grab(qi - 1, -1);
  return after.length >= 2 ? after : before.length >= 2 ? before : [];
}

export function suggestOptions(answerText = "", questions = [], pendingChoices = []) {
  if (pendingChoices.length >= 2) return pendingChoices.slice(0, 6).map((l) => ({ label: clip(String(l), 80), value: String(l) }));
  const lines = String(answerText).split("\n");
  let qi = -1; for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes("?")) { qi = i; break; }
  if (qi >= 0) {
    const items = listNear(lines, qi);
    if (items.length >= 2 && items.length <= 6) return items.map((it, i) => ({ label: short(it.text), value: it.n ? `Option ${it.n}: ${short(it.text)}` : short(it.text) })).filter((o, i, a) => o.label && a.findIndex((x) => x.value === o.value) === i);
  }
  const q = plain(questions.at(-1) || (qi >= 0 ? lines[qi] : ""));
  if (!q) return [];
  const WH = /^(which|what|how|why|when|where|who|whose)\b/i;
  if (WH.test(q)) return [];
  const body = q.replace(/^(should|shall|can|could|do|would|will|may)\s+(i|we|you)\s+(?:(?:use|choose|pick|go with|prefer|keep|switch to|start with)\s+)?/i, "");
  const or = /^([^?,]{2,40}?)\s+or\s+([^?,]{2,40}?)\s*\?/i.exec(body);
  if (or && or[1].split(/\s+/).length <= 5 && or[2].split(/\s+/).length <= 5) { const t = (x) => x.replace(/^(the|a|an)\s+/i, "").trim(); return [t(or[1]), t(or[2])].map((x) => ({ label: clip(x, 40), value: clip(x, 40) })); }
  if (q.length <= 160 && /\?\s*$/.test(q)) return [{ label: "Yes, go ahead", value: "Yes, go ahead." }, { label: "No, don't", value: "No, don't do that." }];
  return [];
}
