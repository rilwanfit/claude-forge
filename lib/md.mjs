// Tiny Markdown to HTML for reports. HTML in the source is escaped first, so a report can never run script.
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const inline = (s) => esc(s)
  .replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|\W)_([^_]+)_(?=\W|$)/g, "$1<em>$2</em>")
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|[\w./-]+)\)/g, (m, t, u) => `<a href="${u}" rel="noopener noreferrer"${u.startsWith("http") ? ' target="_blank"' : ""}>${t}</a>`);
export function markdown(src) {
  const out = []; const lines = src.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("```")) { const buf = []; for (i++; i < lines.length && !lines[i].startsWith("```"); i++) buf.push(lines[i]); out.push(`<pre>${esc(buf.join("\n"))}</pre>`); continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(l); if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^\s*([-*]|\d+\.)\s/.test(l)) { const ord = /^\s*\d+\./.test(l), buf = []; for (; i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i]); i++) buf.push(`<li>${inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>`); i--; out.push(`<${ord ? "ol" : "ul"}>${buf.join("")}</${ord ? "ol" : "ul"}>`); continue; }
    if (l.includes("|") && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1] || "")) {
      const row = (r, t) => `<tr>${r.replace(/^\s*\||\|\s*$/g, "").split("|").map((c) => `<${t}>${inline(c.trim())}</${t}>`).join("")}</tr>`;
      const buf = [row(l, "th")]; for (i += 2; i < lines.length && lines[i].includes("|"); i++) buf.push(row(lines[i], "td")); i--;
      out.push(`<table>${buf.join("")}</table>`); continue;
    }
    if (/^---+$/.test(l.trim())) { out.push("<hr>"); continue; }
    if (!l.trim()) continue;
    const buf = [l]; while (i + 1 < lines.length && lines[i + 1].trim() && !/^(#|```|\s*([-*]|\d+\.)\s)/.test(lines[i + 1])) buf.push(lines[++i]);
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  return out.join("\n");
}
