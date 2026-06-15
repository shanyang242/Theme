// Packages komaritheme-vX.Y.Z.zip ready for `komari-theme.json` + `preview.png` + `dist/` drop-in.
// Uses Node's builtin zlib via a minimal zip stream (no external deps).

import { createWriteStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "komari-theme.json"), "utf8"));
const version = manifest.version ?? "0.0.0";
const short = manifest.short ?? "komaritheme";
const outPath = resolve(root, `${short}-v${version}.zip`);

function crc32(buf) {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, base));
    else out.push({ path: relative(base, full), full, size: st.size });
  }
  return out;
}

const distDir = resolve(root, "dist");
const previewPath = resolve(root, "preview.png");

// Fail with an actionable message instead of a raw ENOENT stack when this script
// is run on its own (the normal `npm run package`/release flow builds + generates
// the preview first, so these always exist there).
for (const [path, hint] of [
  [previewPath, "run `node scripts/make-preview.mjs` (or `npm run package`) first"],
  [distDir, "run `npm run build` (or `npm run package`) first"],
]) {
  if (!existsSync(path)) {
    console.error(`package-zip: missing ${relative(root, path)} — ${hint}.`);
    process.exit(1);
  }
}

const entries = [
  { path: "komari-theme.json", full: resolve(root, "komari-theme.json") },
  { path: "preview.png", full: previewPath },
  ...walk(distDir, root),
];

const stream = createWriteStream(outPath);
let offset = 0;
const cdEntries = [];

for (const entry of entries) {
  const data = readFileSync(entry.full);
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  const nameBuf = Buffer.from(entry.path.replace(/\\/g, "/"), "utf8");
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);            // version needed
  local.writeUInt16LE(0x0800, 6);        // UTF-8 flag
  local.writeUInt16LE(8, 8);             // deflate
  local.writeUInt16LE(0, 10);            // time
  local.writeUInt16LE(0, 12);            // date
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  stream.write(local);
  stream.write(nameBuf);
  stream.write(deflated);
  cdEntries.push({
    nameBuf,
    crc,
    compSize: deflated.length,
    uncompSize: data.length,
    offset,
  });
  offset += 30 + nameBuf.length + deflated.length;
}

const cdStart = offset;
for (const e of cdEntries) {
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0x0800, 8);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt16LE(0, 12);
  cd.writeUInt16LE(0, 14);
  cd.writeUInt32LE(e.crc, 16);
  cd.writeUInt32LE(e.compSize, 20);
  cd.writeUInt32LE(e.uncompSize, 24);
  cd.writeUInt16LE(e.nameBuf.length, 28);
  cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);
  cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(0, 38);
  cd.writeUInt32LE(e.offset, 42);
  stream.write(cd);
  stream.write(e.nameBuf);
  offset += 46 + e.nameBuf.length;
}

const cdSize = offset - cdStart;

const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(cdEntries.length, 8);
eocd.writeUInt16LE(cdEntries.length, 10);
eocd.writeUInt32LE(cdSize, 12);
eocd.writeUInt32LE(cdStart, 16);
eocd.writeUInt16LE(0, 20);
stream.write(eocd);

stream.end(() => {
  console.log(`Wrote ${outPath}`);
});
