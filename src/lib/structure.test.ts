import { PDFDocument } from "pdf-lib";
import { makePrivacyPdf } from "./samples";
import { scanStructure } from "./structure";

describe("scanStructure", () => {
  it("treats a producer string as a small trace", async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage();
    doc.setProducer("Leaky Producer");
    const report = await scanStructure(await doc.save({ useObjectStreams: false }));
    const meta = report.findings.filter((item) => item.kind === "metadata");
    expect(meta).toHaveLength(1);
    expect(meta[0]?.severity).toBe("low");
  });

  it("finds the document secrets in the privacy sample", async () => {
    const report = await scanStructure(await makePrivacyPdf());
    const kinds = report.findings.map((item) => item.kind);
    for (const kind of ["metadata", "attachment", "annotation", "form", "javascript", "link", "revision", "layer", "exif", "pii", "signature"]) {
      expect(kinds, kind).toContain(kind);
    }
    expect(report.findings.find((item) => item.kind === "metadata")?.severity).toBe("medium");
    expect(report.findings.find((item) => item.kind === "layer")?.severity).toBe("high");
    expect(report.findings.find((item) => item.kind === "signature")?.detail).toBe("Signed by Ada Lovelace on 15 Jan 2026.");
    expect(report.findings.find((item) => item.kind === "exif")?.detail).toContain("W");
    expect(report.findings.some((item) => item.kind === "pii" && item.detail.includes("AKIA"))).toBe(true);
    expect(report.findings.some((item) => item.kind === "pii" && item.detail.includes("555"))).toBe(true);
    expect(report.revisions).toHaveLength(1);
    const earlier = await PDFDocument.load(report.revisions[0]!.bytes, { updateMetadata: false });
    expect(earlier.getPageCount()).toBe(2);
  });
});
