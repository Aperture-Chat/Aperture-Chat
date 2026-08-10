/* Shared STORED-only ZIP container writer for hand-built OOXML packages
 * (.docx, .pptx). Format-agnostic: callers supply the named parts.
 * Uncompressed entries keep the XML greppable in tests and diagnostics. */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export type ZipEntry = { name: string; bytes: Uint8Array };

/** Minimal STORED (uncompressed) ZIP builder — enough for an OOXML package. */
export function buildZip(entries: ZipEntry[]) {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const pushLE = (view: DataView, at: number, value: number, size: 2 | 4) => {
    if (size === 2) view.setUint16(at, value, true);
    else view.setUint32(at, value >>> 0, true);
  };

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.bytes);
    const local = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(local.buffer);
    pushLE(view, 0, 0x04034b50, 4);
    pushLE(view, 4, 20, 2); // version needed
    pushLE(view, 6, 0, 2); // flags
    pushLE(view, 8, 0, 2); // method: stored
    pushLE(view, 10, 0, 2); // time
    pushLE(view, 12, 0x21, 2); // date (a fixed valid DOS date)
    pushLE(view, 14, crc, 4);
    pushLE(view, 18, entry.bytes.length, 4);
    pushLE(view, 22, entry.bytes.length, 4);
    pushLE(view, 26, nameBytes.length, 2);
    pushLE(view, 28, 0, 2); // extra length
    local.set(nameBytes, 30);
    chunks.push(local, entry.bytes);

    const centralEntry = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralEntry.buffer);
    pushLE(centralView, 0, 0x02014b50, 4);
    pushLE(centralView, 4, 20, 2); // version made by
    pushLE(centralView, 6, 20, 2); // version needed
    pushLE(centralView, 8, 0, 2);
    pushLE(centralView, 10, 0, 2);
    pushLE(centralView, 12, 0, 2);
    pushLE(centralView, 14, 0x21, 2);
    pushLE(centralView, 16, crc, 4);
    pushLE(centralView, 20, entry.bytes.length, 4);
    pushLE(centralView, 24, entry.bytes.length, 4);
    pushLE(centralView, 28, nameBytes.length, 2);
    pushLE(centralView, 30, 0, 2);
    pushLE(centralView, 32, 0, 2);
    pushLE(centralView, 34, 0, 2);
    pushLE(centralView, 36, 0, 2);
    pushLE(centralView, 38, 0, 4);
    pushLE(centralView, 42, offset, 4);
    centralEntry.set(nameBytes, 46);
    central.push(centralEntry);

    offset += local.length + entry.bytes.length;
  }

  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  pushLE(endView, 0, 0x06054b50, 4);
  pushLE(endView, 4, 0, 2);
  pushLE(endView, 6, 0, 2);
  pushLE(endView, 8, entries.length, 2);
  pushLE(endView, 10, entries.length, 2);
  pushLE(endView, 12, centralSize, 4);
  pushLE(endView, 16, offset, 4);
  pushLE(endView, 20, 0, 2);

  const total =
    chunks.reduce((sum, chunk) => sum + chunk.length, 0) + centralSize + end.length;
  const output = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of [...chunks, ...central, end]) {
    output.set(chunk, cursor);
    cursor += chunk.length;
  }
  return output;
}
