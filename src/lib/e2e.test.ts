import { deflateSync } from "node:zlib";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PDFDocument, PDFName } from "pdf-lib";
import { getDocument, GlobalWorkerOptions, OPS as PdfOps } from "pdfjs-dist/legacy/build/pdf.mjs";
import { auditDocument } from "./audit";
import { fixPdf, stripMetadata } from "./fix";
import { OPS } from "./operators";
import { SECRETS, makeBadPdf, makeCleanPdf } from "./samples";

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

/** 1×1 black PNG. Node has no canvas, so the fixer test uses this as the raster. */
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
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function load(bytes: Uint8Array) {
  const task = getDocument({ data: bytes.slice(), disableFontFace: true, isEvalSupported: false, verbosity: 0 });
  return task.promise;
}

async function pageText(doc: Awaited<ReturnType<typeof load>>, pageNumber: number) {
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  return content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
}

describe("operator ids", () => {
  it("matches pdf.js", () => {
    for (const [name, value] of Object.entries(OPS)) {
      expect(PdfOps[name as keyof typeof PdfOps]).toBe(value);
    }
  });
});

describe("bad redaction sample", () => {
  it("recovers every hidden string and leaves visible text alone", async () => {
    const bytes = await makeBadPdf();
    const committed = new Uint8Array(readFileSync(new URL("../../public/samples/bad-redaction.pdf", import.meta.url)));
    const doc = await load(bytes);
    const fromFile = await load(committed);
    try {
      const report = await auditDocument(doc);
      const fileReport = await auditDocument(fromFile);
      const texts = report.leaks.map((l) => l.text);
      expect(texts).toEqual(expect.arrayContaining([
        SECRETS.ssn,
        SECRETS.account,
        SECRETS.password,
        SECRETS.annot,
        SECRETS.highlight,
        SECRETS.redact,
        SECRETS.tilted,
        SECRETS.rotated,
      ]));
      expect(report.leakCount).toBe(8);
      const blob = texts.join("\n");
      expect(blob).not.toContain(SECRETS.notALeak);
      expect(blob).not.toContain(SECRETS.visible);
      expect(blob).not.toContain("Password:");
      expect(blob).not.toContain(SECRETS.page2);
      expect(report.leaks.find((l) => l.text === SECRETS.password)?.kind).toBe("white");
      expect(report.leaks.find((l) => l.text === SECRETS.annot)?.kind).toBe("annotation");
      expect(report.leaks.find((l) => l.text === SECRETS.ssn)?.kind).toBe("dark");
      expect(report.pages[1].leaks).toEqual([]);
      expect(report.pages[1].coverCount).toBe(0);
      expect(fileReport.leaks.map((l) => l.text).sort()).toEqual([...texts].sort());
    } finally {
      await doc.destroy();
      await fromFile.destroy();
    }
  }, 30_000);

  it("fixes leaked pages, keeps clean pages, and strips metadata", async () => {
    const bytes = await makeBadPdf();
    const doc = await load(bytes);
    const rasterized: number[] = [];
    let fixed!: Uint8Array<ArrayBufferLike>;
    try {
      const report = await auditDocument(doc);
      fixed = await fixPdf({
        source: bytes,
        report,
        rasterize: async (request) => {
          rasterized.push(request.page);
          expect(request.dpi).toBe(200);
          expect(request.covers.length).toBeGreaterThan(0);
          return tinyPng();
        },
      });
    } finally {
      await doc.destroy();
    }

    expect(rasterized).toEqual([1]);
    const out = await load(fixed);
    try {
      const check = await auditDocument(out);
      expect(check.leakCount).toBe(0);
      expect(await pageText(out, 1)).not.toContain("123-45-6789");
      expect(await pageText(out, 1)).not.toContain(SECRETS.password);
      expect(await pageText(out, 2)).toContain(SECRETS.page2);
    } finally {
      await out.destroy();
    }

    const saved = await PDFDocument.load(fixed, { updateMetadata: false });
    expect(saved.getTitle()).toBeUndefined();
    expect(saved.getAuthor()).toBeUndefined();
    expect(saved.getProducer()).toBeUndefined();
    expect(saved.getCreator()).toBeUndefined();
    expect(saved.getSubject()).toBeUndefined();
    expect(saved.catalog.has(PDFName.of("Metadata"))).toBe(false);
    const raw = Buffer.from(fixed).toString("latin1");
    expect(raw).not.toContain("Jane Doe");
    expect(raw).not.toContain("Confidential memo");
    expect(raw).not.toContain("Leaky Producer");
    expect(raw).not.toContain("pdf-lib");
    expect(raw).not.toContain("xmpmeta");
  }, 30_000);
});

describe("clean redaction sample", () => {
  it("finds the black bar and no leaked text", async () => {
    const bytes = await makeCleanPdf();
    const committed = new Uint8Array(readFileSync(new URL("../../public/samples/clean-redaction.pdf", import.meta.url)));
    const doc = await load(bytes);
    const fromFile = await load(committed);
    try {
      const report = await auditDocument(doc);
      const fileReport = await auditDocument(fromFile);
      expect(report.leakCount).toBe(0);
      expect(report.pages[0].coverCount).toBeGreaterThan(0);
      expect(fileReport.leakCount).toBe(0);
    } finally {
      await doc.destroy();
      await fromFile.destroy();
    }
  }, 30_000);
});

describe("stripMetadata", () => {
  it("deletes info fields and XMP", async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.setTitle("Confidential memo");
    doc.setAuthor("Jane Doe");
    doc.setProducer("Leaky Producer");
    const meta = doc.context.stream("<x:xmpmeta>Jane Doe</x:xmpmeta>", { Type: "Metadata", Subtype: "XML" });
    doc.catalog.set(PDFName.of("Metadata"), doc.context.register(meta));
    stripMetadata(doc);
    expect(doc.getTitle()).toBeUndefined();
    expect(doc.getAuthor()).toBeUndefined();
    expect(doc.getProducer()).toBeUndefined();
    expect(doc.catalog.has(PDFName.of("Metadata"))).toBe(false);
  });
});
