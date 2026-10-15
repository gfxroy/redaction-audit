import { safeZipName, zipStore } from "./zip";

function readZip(bytes: Uint8Array): { name: string; data: Uint8Array }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: { name: string; data: Uint8Array }[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const size = view.getUint32(offset + 22, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLen));
    const start = offset + 30 + nameLen + extraLen;
    out.push({ name, data: bytes.slice(start, start + size) });
    offset = start + size;
  }
  return out;
}

describe("zipStore", () => {
  it("packs files without compression and keeps the bytes", () => {
    const first = new TextEncoder().encode("one");
    const second = new TextEncoder().encode("two");
    const packed = zipStore([
      { name: "../notes.pdf", bytes: first },
      { name: "notes.pdf", bytes: second },
    ]);
    const files = readZip(packed);
    expect(files.map((file) => file.name)).toEqual(["notes.pdf", "notes-2.pdf"]);
    expect(files[0]?.data).toEqual(first);
    expect(files[1]?.data).toEqual(second);
    expect(safeZipName("   ", 0)).toBe("file-1.pdf");
  });
});
