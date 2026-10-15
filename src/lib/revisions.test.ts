import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { appendRevision, earlierRevisions, revisionMarks } from "./revisions";

describe("revisions", () => {
  it("keeps an earlier save that still opens", async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage().drawText("Notes for the board.", { x: 72, y: 700, size: 14, font, color: rgb(0, 0, 0) });
    const once = await doc.save({ useObjectStreams: false });
    expect(revisionMarks(once)).toHaveLength(1);
    const twice = appendRevision(once);
    expect(revisionMarks(twice)).toHaveLength(2);
    const [earlier] = earlierRevisions(twice);
    expect(earlier).toBeDefined();
    expect(earlier!.length).toBeLessThan(twice.length);
    const full = await PDFDocument.load(twice, { updateMetadata: false });
    const old = await PDFDocument.load(earlier!, { updateMetadata: false });
    expect(full.getPageCount()).toBe(1);
    expect(old.getPageCount()).toBe(1);
  });
});
