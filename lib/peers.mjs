// Other machines running this dashboard. Each keeps its own data; this machine lists what needs you there, read-only.
// Config: "peers": [{ "name": "work-pc", "url": "https://work-pc.tailnet.example:4777", "tokenEnv": "WORKPC_DASH_TOKEN" }]
const clip = (s, n) => (String(s ?? "").length > n ? String(s).slice(0, n - 1).trimEnd() + "…" : String(s ?? ""));
const safeUrl = (u) => { try { const x = new URL(String(u)); return x.protocol === "https:" || x.protocol === "http:" ? x : null; } catch { return null; } };

/** Items from another machine's overview, rewritten as read-only entries. Items that came from a peer there are dropped, so two machines listing each other never loop. */
export function fromOverview(peer, ov, { now = Date.now() } = {}) {
  const base = safeUrl(peer.url); if (!base) throw new Error("The peer url must be http or https.");
  const take = (list, status) => (Array.isArray(list) ? list : []).filter((i) => i && i.kind !== "peer" && i.title).slice(0, 100).map((i) => ({
    id: `peer:${peer.name}:${clip(i.id ?? i.key ?? i.title, 100)}`, kind: "peer", peerStatus: status, machine: peer.name, projectKey: `peer:${peer.name}`,
    title: clip(i.title, 200), line: clip(i.line ?? "", 240), label: clip(i.label ?? "Needs you", 40), ts: Number(i.ts) || now, rank: status === "needs" ? i.rank ?? 1 : 5,
    primary: { act: "href", href: base.origin + "/", label: `Open on ${peer.name}` },
  }));
  return { needs: take(ov?.needs, "needs"), running: take(ov?.running, "running") };
}

/** Fetches one peer. Never throws: { needs, running, error }. */
export async function fetchPeer(peer, { fetch = (...a) => globalThis.fetch(...a), env = process.env } = {}) {
  try {
    if (!peer?.name || !peer?.url) throw new Error('A peer needs a "name" and a "url".');
    const token = peer.tokenEnv ? env[peer.tokenEnv] : ""; if (peer.tokenEnv && !token) throw new Error(`Set the ${peer.tokenEnv} environment variable.`);
    const base = safeUrl(peer.url); if (!base) throw new Error("The peer url must be http or https.");
    const r = await fetch(new URL("/api/overview", base).href, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(8000), redirect: "error" });
    if (r.status === 401) throw new Error("The peer wants an access token: set tokenEnv.");
    if (!r.ok) throw new Error(`The peer answered ${r.status}.`);
    return { ...fromOverview(peer, await r.json()), error: null };
  } catch (e) { return { needs: [], running: [], error: clip(e.name === "TimeoutError" ? "The peer did not answer in time." : e.message, 160) }; }
}
