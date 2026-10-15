import { AnnotationMode, type PDFDocumentProxy } from "pdfjs-dist";
import type { Cover, PageAudit } from "./lib/types";
import type { RasterRequest } from "./lib/fix";

export interface Thumbnail {
  page: number;
  url: string;
  width: number;
  height: number;
  /** Leak polygons in thumbnail pixel space, one "x,y x,y" string each. */
  outlines: string[];
}

function pngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error("Could not encode the page."));
        return;
      }
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, "image/png");
  });
}

function paintPolygon(
  ctx: CanvasRenderingContext2D,
  viewport: { convertToViewportPoint(x: number, y: number): number[] },
  polygon: { x: number; y: number }[],
  fill: string,
) {
  if (polygon.length < 3) return;
  ctx.beginPath();
  polygon.forEach((point, index) => {
    const [x, y] = viewport.convertToViewportPoint(point.x, point.y);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function outline(viewport: { convertToViewportPoint(x: number, y: number): number[] }, polygon: { x: number; y: number }[]) {
  return polygon
    .map((point) => {
      const [x, y] = viewport.convertToViewportPoint(point.x, point.y);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

/**
 * Draw the page, then paint every cover into the bitmap.
 * Annotation rectangles have no appearance stream, so the render leaves the text visible until this burn.
 */
export async function rasterizePage(doc: PDFDocumentProxy, request: RasterRequest): Promise<Uint8Array> {
  const page = await doc.getPage(request.page);
  const viewport = page.getViewport({ scale: request.dpi / 72 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not draw the page.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, viewport, annotationMode: AnnotationMode.DISABLE }).promise;
  for (const cover of request.covers) burn(ctx, viewport, cover);
  return pngBytes(canvas);
}

function burn(
  ctx: CanvasRenderingContext2D,
  viewport: { convertToViewportPoint(x: number, y: number): number[] },
  cover: Cover,
) {
  paintPolygon(ctx, viewport, cover.polygon, cover.kind === "white" ? "#ffffff" : "#000000");
}

/** Preview for a page that has leaks. Annotation covers are filled so a box with no appearance still shows. */
export async function renderThumbnail(doc: PDFDocumentProxy, audit: PageAudit): Promise<Thumbnail | null> {
  if (!audit.leaks.length) return null;
  const page = await doc.getPage(audit.page);
  const base = page.getViewport({ scale: 1 });
  const scale = (520 / base.width) * Math.min(2, window.devicePixelRatio || 1);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, viewport, annotationMode: AnnotationMode.DISABLE }).promise;
  for (const cover of audit.covers) {
    if (cover.kind === "annotation") paintPolygon(ctx, viewport, cover.polygon, "#000000");
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return null;
  return {
    page: audit.page,
    url: URL.createObjectURL(blob),
    width: canvas.width,
    height: canvas.height,
    outlines: audit.leaks.map((leak) => outline(viewport, leak.polygon)),
  };
}
