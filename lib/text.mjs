// Small text helpers shared by the session collector and the transcript index.
export const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

export const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((b) => b && b.type === "text").map((b) => b.text).join("\n")
      : "";

/** A user record is a real prompt: typed text, not a tool result, a hook note or a meta line. */
export function promptText(rec) {
  if (rec.type !== "user" || rec.isMeta || rec.isSidechain) return null;
  const c = rec.message?.content;
  if (Array.isArray(c) && c.some((b) => b?.type === "tool_result")) return null;
  const t = textOf(c).trim();
  if (!t || t.startsWith("<local-command") || t.startsWith("<system-reminder>") || t.startsWith("Caveat:")) return null;
  const cmd = /<command-name>([^<]+)<\/command-name>/.exec(t);
  if (cmd) return cmd[1].trim();
  return t;
}

const ASK_HEADING = /(decision|decide|for you|needs? (your|you)|your (call|input|answer)|open question|waiting (on|for) you|to confirm|still open|pending)/i;
const ASK_PHRASE = /\b(should i|shall i|may i|do you want|would you like|let me know|tell me (which|whether|if)|say the word|your call|which (one|option)|can you (confirm|run|check))\b/i;

/** The questions in a final answer: lines with a question mark, and the items under a "decisions for you" heading. */
export function questionsIn(text) {
  const out = [];
  let inCode = false;
  let underAsk = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) { inCode = !inCode; continue; }
    if (inCode || !line) { if (!line) underAsk = underAsk && out.length < 12; continue; }
    const plain = line.replace(/https?:\/\/\S+/g, "").replace(/\S*\?\S*=\S*/g, "").replace(/[*_`#>]/g, "").trim();
    const isHeading = /^(#{1,4}\s|\*\*[^*]+\*\*:?$)/.test(line) || (/:$/.test(plain) && plain.length < 80);
    if (isHeading) { underAsk = ASK_HEADING.test(plain); if (underAsk && plain.includes("?")) out.push(plain); continue; }
    const isItem = /^([-*]|\d+[.)])\s/.test(line);
    if (plain.includes("?") || (underAsk && isItem) || ASK_PHRASE.test(plain)) out.push(plain.replace(/^([-*]|\d+[.)])\s*/, ""));
  }
  return [...new Set(out)].slice(0, 8).map((q) => clip(q, 260));
}
