import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { qrMatrix, qrSvg, MAX_BYTES } from "../qr.mjs";

const hash = (m) => crypto.createHash("sha256").update(m.map((r) => r.map((v) => (v ? 1 : 0)).join("")).join("\n")).digest("hex").slice(0, 16);
const version = (m) => (m.length - 17) / 4;

test("the version grows at the byte capacity of each size", () => {
  // level M, byte mode: 14, 26, 42, 62, 84, 106, 122, 152, 180, 213 bytes for versions 1 to 10
  const caps = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
  caps.forEach((cap, i) => {
    assert.equal(version(qrMatrix("x".repeat(cap))), i + 1, `${cap} bytes fit in version ${i + 1}`);
    if (i < caps.length - 1) assert.equal(version(qrMatrix("x".repeat(cap + 1))), i + 2, `${cap + 1} bytes need version ${i + 2}`);
  });
  assert.equal(MAX_BYTES, 213);
});

test("text that is too long is refused, not cut off", () => {
  assert.throws(() => qrMatrix("x".repeat(214)), /Too long/);
  assert.throws(() => qrMatrix("é".repeat(110)), /Too long/, "the limit counts UTF-8 bytes, not characters");
});

test("every code has the three finder patterns, the timing lines and the dark module", () => {
  for (const len of [1, 30, 100, 213]) {
    const m = qrMatrix("y".repeat(len)); const n = m.length;
    for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
      for (let d = 0; d < 7; d++) for (const [x, y] of [[d, 0], [d, 6], [0, d], [6, d]]) assert.ok(m[oy + y][ox + x], "finder ring");
      for (let a = 2; a <= 4; a++) for (let b = 2; b <= 4; b++) assert.ok(m[oy + a][ox + b], "finder centre");
      for (let a = 1; a <= 5; a++) { assert.ok(!m[oy + 1][ox + a] && !m[oy + 5][ox + a], "light ring"); }
    }
    for (let i = 8; i < n - 8; i++) { assert.equal(m[6][i], i % 2 === 0, "timing row"); assert.equal(m[i][6], i % 2 === 0, "timing column"); }
    assert.ok(m[n - 8][8], "dark module");
  }
});

// These hashes were taken from codes that Apple's Vision barcode reader decoded back to the exact text (see the test below).
// If you change the encoder on purpose, check the new output with a real decoder before you update them.
test("the encoder output has not changed (golden hashes, checked with a real decoder)", () => {
  const golden = [
    ["a", 1, "e8ab680854e4019c"], ["hello world", 1, "851bd1031e2539fc"], ["x".repeat(84) + "7", 6, "a099a7c0065b04d5"],
    ["http://192.168.100.200:4777/pair?code=" + "Zk3_-aQ9".repeat(4), 5, "970b4d461a363a92"], ["x".repeat(212) + "7", 10, "21f33a8be8826545"], ["héllo wörld ✓ ünïcode", 3, "eef69696aa980031"],
  ];
  for (const [text, ver, h] of golden) { const m = qrMatrix(text); assert.equal(version(m), ver); assert.equal(hash(m), h, `hash for ${text.slice(0, 20)}`); }
});

test("the SVG is black on white with a quiet zone, whatever the page theme", () => {
  const svg = qrSvg("http://10.0.0.5:4777/pair?code=abc", { scale: 4, margin: 4, label: "pair" });
  const size = qrMatrix("http://10.0.0.5:4777/pair?code=abc").length + 8;
  assert.match(svg, new RegExp(`viewBox="0 0 ${size} ${size}"`)); assert.match(svg, /width="\d+" height="\d+"/);
  assert.match(svg, /<rect [^>]*fill="#fff"/); assert.match(svg, /<path d="M[^"]+" fill="#000"/); assert.match(svg, /aria-label="pair"/);
  assert.ok(!/<script|onload|href/i.test(svg));
});

// A real decoder: Apple's Vision framework through Swift. Runs only on a Mac with Swift, and only when asked (QR_DECODE=1),
// because compiling the small decoder takes a few seconds.
const canDecode = process.platform === "darwin" && process.env.QR_DECODE === "1" && spawnSync("swiftc", ["--version"]).status === 0;
test("codes decode back to the exact text with a real decoder (macOS, QR_DECODE=1)", { skip: !canDecode && "set QR_DECODE=1 on a Mac with Swift" }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "qrd-"));
  const png = (m, scale = 8, margin = 4) => {
    const n = (m.length + margin * 2) * scale; const rows = [];
    for (let y = 0; y < n; y++) { const row = Buffer.alloc(n + 1, 255); for (let x = 0; x < n; x++) { const mx = Math.floor(x / scale) - margin, my = Math.floor(y / scale) - margin; if (mx >= 0 && my >= 0 && mx < m.length && my < m.length && m[my][mx]) row[x + 1] = 0; } rows.push(row); }
    const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4); d.copy(b, 8); b.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(t), d])) >>> 0, 8 + d.length); return b; };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
  };
  const texts = [1, 14, 15, 26, 27, 42, 43, 62, 63, 84, 85, 106, 107, 122, 123, 152, 153, 180, 181, 213].map((n) => "x".repeat(n - 1) + "7").concat(["http://192.168.100.200:4777/pair?code=" + "Zk3_-aQ9".repeat(4), "héllo wörld ✓ ünïcode"]);
  const files = []; for (let i = 0; i < texts.length; i++) { const f = path.join(dir, `${String(i).padStart(2, "0")}.png`); await writeFile(f, png(qrMatrix(texts[i]))); files.push(f); }
  await writeFile(path.join(dir, "dec.swift"), 'import Vision\nimport AppKit\nfor p in CommandLine.arguments.dropFirst() { guard let img = NSImage(contentsOfFile: p) else { print("UNREADABLE"); continue }; var r = CGRect(origin: .zero, size: img.size); guard let cg = img.cgImage(forProposedRect: &r, context: nil, hints: nil) else { print("NOCG"); continue }; let q = VNDetectBarcodesRequest(); q.symbologies = [.qr]; try? VNImageRequestHandler(cgImage: cg).perform([q]); print((q.results ?? []).compactMap { $0.payloadStringValue }.first ?? "NONE") }\n');
  const build = spawnSync("swiftc", ["-O", "-o", path.join(dir, "dec"), path.join(dir, "dec.swift")], { encoding: "utf8" }); assert.equal(build.status, 0, build.stderr);
  const out = spawnSync(path.join(dir, "dec"), files, { encoding: "utf8" }).stdout.split("\n").slice(0, texts.length);
  texts.forEach((t, i) => assert.equal(out[i], t, `code ${i} (${t.length} bytes)`));
});
