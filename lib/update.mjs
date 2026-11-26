// Update notice: is this checkout behind the public main branch?
// One anonymous GET a day to api.github.com. It sends nothing about you or your machine except the commit id of this checkout.
// Off with "updateCheck": false in config.json. Does nothing when this folder is not a git checkout.
export const REPO = "rilwanfit/claude-forge";
export const BRANCH = "main";
export const API = "https://api.github.com";

const subject = (msg) => { const s = String(msg || "").split("\n")[0].trim(); return s.length > 100 ? s.slice(0, 99).trimEnd() + "…" : s; };

/** GET a GitHub API path and return the parsed JSON, or null on any failure (offline, rate limit, unknown commit). */
export function makeGet(base = API, fetchFn = (url, init) => fetch(url, init)) {
  return async (p) => {
    const r = await fetchFn(base + p, { headers: { accept: "application/vnd.github+json", "user-agent": "claude-forge-update-check" }, signal: AbortSignal.timeout(8000) }).catch(() => null);
    return r?.ok ? r.json().catch(() => null) : null;
  };
}

/**
 * Compares this checkout (head) with the public branch.
 * Returns null when the answer is unknown (not a git checkout, offline, or a commit GitHub does not know, such as a fork).
 */
export async function checkForUpdate({ head, get, repo = REPO, branch = BRANCH }) {
  const sha = await head(); if (!sha) return null;
  const r = await get(`/repos/${repo}/compare/${sha}...${branch}`); if (!r || typeof r.status !== "string") return null;
  const behind = Number(r.ahead_by) || 0; // commits on the public branch that this checkout does not have
  const commits = Array.isArray(r.commits) ? r.commits : [];
  return {
    checkedAt: Date.now(), available: behind > 0 && (r.status === "ahead" || r.status === "diverged"), behind,
    diverged: r.status === "diverged", // you have your own commits too, so a plain pull cannot fast-forward
    current: sha.slice(0, 7), latest: commits.length ? String(commits[commits.length - 1].sha).slice(0, 7) : sha.slice(0, 7),
    changes: commits.slice(-5).reverse().map((c) => subject(c.commit?.message)), url: `https://github.com/${repo}/compare/${sha.slice(0, 12)}...${branch}`,
  };
}
