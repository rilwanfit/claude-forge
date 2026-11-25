// Credential stripping for anything shown in the UI or passed to Claude (logs, previews, handoffs).
// Known token shapes, PEM keys, credentials in URLs, Authorization headers, and NAME=value pairs whose name looks secret.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /sk-ant-[\w-]{8,}/g, /\bsk-[A-Za-z0-9_-]{20,}/g, /\b[sr]k_(?:live|test)_\w{10,}/g, /\bwhsec_\w{10,}/g,
  /\bgh[pousr]_\w{16,}/g, /github_pat_\w{20,}/g, /\bnpm_[A-Za-z0-9]{30,}/g, /\bxox[abprs]-[\w-]{10,}/g,
  /hooks\.slack\.com\/services\/[\w/]+/g, /\bAIza[\w-]{30,}/g, /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}/g, // JWT
  /\bBearer\s+[\w.~+/-]{12,}=*/gi,
  /(\bauthorization["']?\s*[:=]\s*["']?)(?:basic|bearer|token)?\s*[\w.~+/=-]{8,}/gi,
  /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/gi, // scheme://user:password@host
  /((?:api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|token|secret|password|passwd|pwd)\w*["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi,
];

export function redact(text, extra = []) {
  let out = String(text ?? "");
  for (const v of extra) if (v && v.length >= 8) out = out.split(v).join("•••");
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m, pre) => (typeof pre === "string" ? pre + "•••" : "•••"));
  return out;
}

/** Files whose names say they hold credentials: never offered as "relevant files". */
export const SECRET_FILE = /(^|\/)(\.env(\.[\w-]+)?|\.npmrc|\.netrc|credentials(\.json)?|id_(rsa|ed25519|ecdsa)|[\w.-]*\.(pem|key|p12|pfx)|\.claude-secrets(\/.*)?)$/i;
