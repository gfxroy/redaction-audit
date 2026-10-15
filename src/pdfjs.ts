import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

const base = import.meta.env.BASE_URL;

/** Open a PDF entirely in the browser. The bytes are copied because the worker may detach them. */
export function openPdf(data: Uint8Array): Promise<PDFDocumentProxy> {
  return getDocument({
    data: data.slice(),
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
  }).promise;
}
