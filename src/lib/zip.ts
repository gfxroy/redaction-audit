function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}

export function safeZipName(name: string, index: number): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/^\.+/, "").replace(/[^\w. -]+/g, "").trim();
  return cleaned || `file-${index + 1}.pdf`;
}

function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let n = 2;
  let next = `${stem}-${n}${ext}`;
  while (used.has(next)) {
    n += 1;
    next = `${stem}-${n}${ext}`;
  }
  used.add(next);
  return next;
}

function u16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}
function u32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value, true);
}

/** A store-only ZIP (no compression), enough for several cleaned PDFs. */
export function zipStore(files: { name: string; bytes: Uint8Array }[]): Uint8Array {
  const used = new Set<string>();
  const entries = files.map((file, index) => {
    const name = uniqueName(safeZipName(file.name, index), used);
    return { name: new TextEncoder().encode(name), bytes: file.bytes, crc: crc32(file.bytes) };
  });
  let size = 22;
  for (const entry of entries) size += 30 + entry.name.length + entry.bytes.length + 46 + entry.name.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let offset = 0;
  const locals: number[] = [];
  for (const entry of entries) {
    locals.push(offset);
    u32(view, offset, 0x04034b50);
    u16(view, offset + 4, 20);
    u16(view, offset + 8, 0);
    u32(view, offset + 14, entry.crc);
    u32(view, offset + 18, entry.bytes.length);
    u32(view, offset + 22, entry.bytes.length);
    u16(view, offset + 26, entry.name.length);
    out.set(entry.name, offset + 30);
    out.set(entry.bytes, offset + 30 + entry.name.length);
    offset += 30 + entry.name.length + entry.bytes.length;
  }
  const central = offset;
  entries.forEach((entry, index) => {
    u32(view, offset, 0x02014b50);
    u16(view, offset + 4, 20);
    u16(view, offset + 6, 20);
    u32(view, offset + 16, entry.crc);
    u32(view, offset + 20, entry.bytes.length);
    u32(view, offset + 24, entry.bytes.length);
    u16(view, offset + 28, entry.name.length);
    u32(view, offset + 42, locals[index] ?? 0);
    out.set(entry.name, offset + 46);
    offset += 46 + entry.name.length;
  });
  u32(view, offset, 0x06054b50);
  u16(view, offset + 8, entries.length);
  u16(view, offset + 10, entries.length);
  u32(view, offset + 12, offset - central);
  u32(view, offset + 16, central);
  return out;
}
