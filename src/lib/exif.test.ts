import { PDFDocument } from "pdf-lib";
import { jpegWithGps, readExif } from "./exif";

describe("readExif", () => {
  it("reads a GPS fix from an APP1 block", () => {
    const info = readExif(jpegWithGps(37.7749, -122.4194));
    expect(info?.gps?.lat).toBeCloseTo(37.7749, 3);
    expect(info?.gps?.lon).toBeCloseTo(-122.4194, 3);
    expect(info?.gps?.label).toContain("N");
    expect(info?.gps?.label).toContain("W");
  });

  it("embeds that JPEG without dropping the GPS block", async () => {
    const jpg = jpegWithGps();
    const doc = await PDFDocument.create({ updateMetadata: false });
    const page = doc.addPage();
    const image = await doc.embedJpg(jpg);
    page.drawImage(image, { x: 10, y: 10, width: 20, height: 20 });
    const saved = await doc.save({ useObjectStreams: false });
    const info = readExif(saved);
    expect(info?.gps?.lat).toBeCloseTo(37.7749, 3);
    expect(info?.gps?.label).toContain("W");
  });
});
