import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import type { AuditReport, Cover } from "./types";

export const FIX_DPI = 200;

export interface RasterRequest {
  pageIndex: number;
  page: number;
  width: number;
  height: number;
  dpi: number;
  covers: Cover[];
}

export type RasterizePage = (request: RasterRequest) => Promise<Uint8Array>;

/** Remove info-dictionary fields and the catalog XMP metadata stream. */
export function stripMetadata(doc: PDFDocument) {
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  if (info instanceof PDFDict) {
    for (const key of ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate", "Trapped"]) {
      info.delete(PDFName.of(key));
    }
  }
  doc.catalog.delete(PDFName.of("Metadata"));
}

/**
 * Rebuild the PDF. Every page that has a dark box, whiteout, or redaction
 * annotation is replaced by a raster at {@link FIX_DPI} with those covers
 * painted into the pixels. Pages with no covers are copied as vectors.
 * Title, author, producer, and XMP are removed.
 */
export async function fixPdf(options: {
  source: Uint8Array;
  report: AuditReport;
  rasterize: RasterizePage;
  dpi?: number;
}): Promise<Uint8Array> {
  const dpi = options.dpi ?? FIX_DPI;
  const src = await PDFDocument.load(options.source, { updateMetadata: false });
  const out = await PDFDocument.create({ updateMetadata: false });
  const byPage = new Map(options.report.pages.map((p) => [p.page, p]));

  for (let i = 0; i < src.getPageCount(); i++) {
    const pageNumber = i + 1;
    const audit = byPage.get(pageNumber);
    const srcPage = src.getPage(i);
    const size = srcPage.getSize();
    const width = audit?.width || size.width;
    const height = audit?.height || size.height;
    if (audit && audit.coverCount > 0) {
      const png = await options.rasterize({
        pageIndex: i,
        page: pageNumber,
        width,
        height,
        dpi,
        covers: audit.covers,
      });
      const image = await out.embedPng(png);
      const page = out.addPage([width, height]);
      page.drawImage(image, { x: 0, y: 0, width, height });
    } else {
      const [copied] = await out.copyPages(src, [i]);
      out.addPage(copied);
    }
  }

  stripMetadata(out);
  return out.save({ useObjectStreams: false, addDefaultPage: false });
}
