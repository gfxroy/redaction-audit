import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { cleanPdf, DEFAULT_TOGGLES } from "./clean";
import { appendRevision, revisionMarks } from "./revisions";
import { scanStructure } from "./structure";
import type { AuditReport } from "./types";

const emptyAudit = (pages = 1): AuditReport => ({
  pageCount: pages,
  leakCount: 0,
  leaks: [],
  pages: Array.from({ length: pages }, (_, index) => ({
    page: index + 1,
    width: 612,
    height: 792,
    leaks: [],
    covers: [],
    coverCount: 0,
  })),
});

describe("cleanPdf", () => {
  it("strips file info, scripts, and attachments, and drops the earlier save", async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage().drawText("Hello", { x: 72, y: 700, size: 14, font, color: rgb(0, 0, 0) });
    doc.setAuthor("Ada Lovelace");
    doc.setTitle("Confidential memo");
    doc.addJavaScript("boot", "app.alert('hi')");
    await doc.attach(new TextEncoder().encode("secret"), "notes.txt");
    const source = appendRevision(await doc.save({ useObjectStreams: false }));
    const before = await scanStructure(source);
    expect(before.findings.map((item) => item.kind)).toEqual(expect.arrayContaining(["metadata", "javascript", "attachment", "revision"]));

    let rasterized = false;
    const cleaned = await cleanPdf({
      source,
      report: emptyAudit(),
      rasterize: async () => {
        rasterized = true;
        return new Uint8Array();
      },
      toggles: DEFAULT_TOGGLES,
    });
    expect(rasterized).toBe(false);
    const after = await scanStructure(cleaned);
    expect(after.findings).toEqual([]);
    expect(after.revisions).toEqual([]);
    expect(Buffer.from(cleaned).toString("latin1")).not.toContain("Ada Lovelace");
  });

  it("leaves the bytes alone when every toggle is off", async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage();
    const source = appendRevision(await doc.save({ useObjectStreams: false }));
    const cleaned = await cleanPdf({
      source,
      report: emptyAudit(),
      rasterize: async () => new Uint8Array(),
      toggles: {
        burnRedactions: false,
        stripMetadata: false,
        removeAttachments: false,
        removeScripts: false,
        removeAnnotations: false,
        flattenForms: false,
      },
    });
    expect(revisionMarks(cleaned)).toHaveLength(2);
    expect(cleaned).toEqual(source);
  });
});
