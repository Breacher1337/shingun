// Zip fixture builder for the ingest tests: stored (method 0) entries with
// valid CRC32 — the same format every packager emits.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }

export function buildZip(entries) {
  const parts = [];
  for (const [name, content] of entries) {
    const data = Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const header = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), // signature, version, flags, method 0 (stored)
      u16(0), u16(0),                           // time, date
      u32(crc32(data)), u32(data.length), u32(data.length),
      u16(nameBuf.length), u16(0), nameBuf
    ]);
    parts.push(header, data);
  }
  return Buffer.concat(parts);
}
