import { deflateSync } from "node:zlib";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { cleanPdf } from "./clean";
import { scanDocument } from "./scan";
import { makePrivacyPdf } from "./samples";

const require = createRequire(import.meta.url);
GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function tinyPng(): Uint8Array {
  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, 1);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = deflateSync(Uint8Array.from([0, 0, 0, 0]));
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function load(bytes: Uint8Array) {
  return getDocument({ data: bytes.slice(), disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
}

const EXPECTED = [
  "annotation",
  "attachment",
  "exif",
  "form",
  "hidden-text",
  "javascript",
  "layer",
  "link",
  "metadata",
  "off-page",
  "pii",
  "redaction",
  "revision",
  "signature",
  "tiny-text",
];

describe("privacy sample", () => {
  it("scores the leaky file as F and the cleaned copy as A", async () => {
    const bytes = await makePrivacyPdf();
    const doc = await load(bytes);
    const rasterized: number[] = [];
    let cleaned!: Uint8Array<ArrayBufferLike>;
    try {
      const report = await scanDocument(bytes, doc);
      const kinds = [...new Set(report.findings.map((item) => item.kind))].sort();
      expect(kinds).toEqual(EXPECTED);
      expect(report.score.letter).toBe("F");
      expect(report.audit.pages[1]?.coverCount).toBe(0);
      expect(report.audit.pages[0]?.coverCount).toBeGreaterThan(0);
      cleaned = await cleanPdf({
        source: bytes,
        report: report.audit,
        rasterize: async (request) => {
          rasterized.push(request.page);
          return tinyPng();
        },
      });
    } finally {
      await doc.destroy();
    }

    expect(rasterized).toEqual([1]);
    const out = await load(cleaned);
    try {
      const again = await scanDocument(cleaned, out);
      expect(again.findings.map((item) => `${item.severity} ${item.kind} ${item.title} ${item.detail}`)).toEqual([]);
      expect(again.score.letter).toBe("A");
      const page = await out.getPage(2);
      const text = (await page.getTextContent()).items.map((item) => ("str" in item ? item.str : "")).join(" ");
      expect(text).toContain("Notes for the board.");
    } finally {
      await out.destroy();
    }
    const raw = Buffer.from(cleaned).toString("latin1");
    expect(raw).not.toContain("123-45-6789");
    expect(raw).not.toContain("ada@example.com");
    expect(raw).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(raw).not.toContain("Ada Lovelace");
  }, 60_000);
});
