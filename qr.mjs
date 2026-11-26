// A small QR code encoder with no dependencies. Byte mode, error correction level M, versions 1 to 10
// (up to 213 bytes). It is used by the page to show a pairing code, and the tests check it with a real decoder.
// Follows ISO/IEC 18004: Reed-Solomon over GF(256) with polynomial 0x11D, the eight data masks, and the standard penalty rules.

// Per version: error correction codewords per block, then [block count, data codewords per block] groups. Level M.
const BLOCKS = {
  1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]],
  6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]],
};
export const MAX_BYTES = 213;
const bit = (x, i) => ((x >>> i) & 1) !== 0;

const dataCodewords = (ver) => BLOCKS[ver][1].reduce((n, [count, size]) => n + count * size, 0);
const byteCapacity = (ver) => dataCodewords(ver) - (ver <= 9 ? 2 : 3); // minus the 4-bit mode and the 8 or 16-bit length

function rawModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) { const a = Math.floor(ver / 7) + 2; n -= (25 * a - 10) * a - 55; if (ver >= 7) n -= 36; }
  return n;
}

// --- Reed-Solomon
const gfMul = (x, y) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z; };
function rsDivisor(degree) {
  const r = new Array(degree).fill(0); r[degree - 1] = 1; let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) { r[j] = gfMul(r[j], root); if (j + 1 < degree) r[j] ^= r[j + 1]; }
    root = gfMul(root, 2);
  }
  return r;
}
function rsRemainder(data, divisor) {
  const r = divisor.map(() => 0);
  for (const b of data) { const f = b ^ r.shift(); r.push(0); divisor.forEach((c, i) => { r[i] ^= gfMul(c, f); }); }
  return r;
}

function dataBits(bytes, ver) {
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(0b0100, 4); put(bytes.length, ver <= 9 ? 8 : 16); bytes.forEach((b) => put(b, 8));
  const cap = dataCodewords(ver) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out = []; for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  return out;
}

function interleave(data, ver) {
  const [ecLen, groups] = BLOCKS[ver]; const div = rsDivisor(ecLen); const blocks = []; let k = 0;
  for (const [count, size] of groups) for (let i = 0; i < count; i++) { const d = data.slice(k, k + size); k += size; blocks.push({ d, e: rsRemainder(d, div) }); }
  const out = []; const maxData = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}

const alignPositions = (ver) => {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2; const size = ver * 4 + 17; const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const r = [6]; for (let pos = size - 7; r.length < n; pos -= step) r.splice(1, 0, pos); return r;
};

const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function penalty(m) {
  const n = m.length; let p = 0;
  const lines = [...m, ...m.map((_, x) => m.map((row) => row[x]))];
  for (const line of lines) { // rule 1: runs of five or more; rule 3: a 1:1:3:1:1 finder-like pattern next to four light modules
    let run = 1;
    for (let i = 1; i <= n; i++) { if (i < n && line[i] === line[i - 1]) run++; else { if (run >= 5) p += run - 2; run = 1; } }
    const s = line.map((v) => (v ? "1" : "0")).join("");
    for (const pat of ["10111010000", "00001011101"]) for (let i = s.indexOf(pat); i !== -1; i = s.indexOf(pat, i + 1)) p += 40;
  }
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3; // rule 2
  const dark = m.flat().filter(Boolean).length; p += Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10; // rule 4: balance of dark and light
  return p;
}

/** The QR code for a string as rows of booleans (true = dark), without the quiet zone. Throws when the text is too long. */
export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(String(text))];
  const ver = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].find((v) => bytes.length <= byteCapacity(v));
  if (!ver) throw new RangeError(`Too long for this QR encoder: ${bytes.length} bytes (the limit is ${MAX_BYTES}).`);
  const codewords = interleave(dataBits(bytes, ver), ver);
  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x, y, dark) => { modules[y][x] = dark; isFn[y][x] = true; };

  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); } // timing patterns
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) { // finder patterns with their light separators
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy)); setFn(x, y, d !== 2 && d !== 4);
    }
  }
  const ap = alignPositions(ver);
  for (const cy of ap) for (const cx of ap) {
    if ((cx === 6 && cy === 6) || (cx === 6 && cy === ap[ap.length - 1]) || (cx === ap[ap.length - 1] && cy === 6)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const drawFormat = (mask) => { // level M is 00; BCH(15,5) with generator 0x537, xor 0x5412
    const data = (0 << 3) | mask; let rem = data; for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(bits, i));
    setFn(8, 7, bit(bits, 6)); setFn(8, 8, bit(bits, 7)); setFn(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(bits, i));
    setFn(8, size - 8, true);
  };
  drawFormat(0); // reserves the format areas so data skips them
  if (ver >= 7) { // BCH(18,6) with generator 0x1F25
    let rem = ver; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) { const a = size - 11 + (i % 3), b = Math.floor(i / 3); setFn(a, b, bit(bits, i)); setFn(b, a, bit(bits, i)); }
  }

  let i = 0; // the data, in the zigzag order the standard defines
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j; const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (!isFn[y][x] && i < codewords.length * 8) { modules[y][x] = bit(codewords[i >>> 3], 7 - (i & 7)); i++; }
    }
  }

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = modules.map((row) => row.slice());
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFn[y][x] && MASKS[mask](x, y)) m[y][x] = !m[y][x];
    const saved = modules.map((row) => row.slice()); // draw the format bits for this mask onto the masked copy
    for (let y = 0; y < size; y++) modules[y] = m[y];
    drawFormat(mask);
    const score = penalty(modules);
    if (!best || score < best.score) best = { score, m: modules.map((row) => row.slice()) };
    for (let y = 0; y < size; y++) modules[y] = saved[y];
  }
  return best.m;
}

/** An SVG string for a string. Dark modules are always black on white, so a phone camera reads it in light and dark themes. */
export function qrSvg(text, { scale = 6, margin = 4, label = "QR code" } = {}) {
  const m = qrMatrix(text); const n = m.length + margin * 2; let d = "";
  m.forEach((row, y) => { let x = 0; while (x < row.length) { if (!row[x]) { x++; continue; } let w = 1; while (x + w < row.length && row[x + w]) w++; d += `M${x + margin} ${y + margin}h${w}v1h-${w}z`; x += w; } });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n * scale}" height="${n * scale}" role="img" aria-label="${label}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
