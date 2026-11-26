// Toast messages, shared by the pages. A short confirmation fades out. An error stays until you close it,
// and you can select its text or press Copy, so you can paste the reason into a bug report.
let timer;
const el = () => document.querySelector("#toast");
function hide() { clearTimeout(timer); el()?.classList.remove("show"); }

export function toast(msg, { error = false } = {}) {
  const t = el(); if (!t) return;
  clearTimeout(timer);
  t.classList.toggle("error", error);
  t.setAttribute("role", error ? "alert" : "status");
  t.textContent = "";
  const text = document.createElement("span"); text.className = "toast-msg"; text.textContent = String(msg); t.append(text);
  if (error) {
    const btn = (label, aria) => { const b = document.createElement("button"); b.type = "button"; b.className = "toast-btn"; b.textContent = label; if (aria) b.setAttribute("aria-label", aria); return b; };
    const copy = btn("Copy"); const close = btn("×", "Close");
    copy.addEventListener("click", async () => {
      let ok = false; try { await navigator.clipboard.writeText(String(msg)); ok = true; } catch { /* clipboard blocked: select the text by hand */ }
      if (!ok) { const r = document.createRange(); r.selectNodeContents(text); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
      copy.textContent = ok ? "Copied" : "Press Ctrl+C";
    });
    close.addEventListener("click", hide);
    t.append(copy, close);
  }
  t.classList.add("show");
  if (!error) timer = setTimeout(hide, 2600);
}
