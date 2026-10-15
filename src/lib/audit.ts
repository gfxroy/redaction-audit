import { aabb, convexHull, luminance, rectToPoly } from "./geometry";
import { findLeaks } from "./intersect";
import { DARK_LUMINANCE, MIN_COVER_AREA, matchPaintIndices, walkOperatorList, type WalkedCover } from "./operators";
import type { AuditReport, Cover, Mat, PageAudit, Pt, Rect, TextRun } from "./types";

/** pdf.js AnnotationMode.DISABLE. Annotation appearances are handled separately. */
const ANNOTATION_MODE_DISABLE = 0;

export interface PdfPageLike {
  getViewport(params: { scale: number }): { width: number; height: number };
  getTextContent(params?: { disableNormalization?: boolean }): Promise<{ items: unknown[] }>;
  getOperatorList(params?: { annotationMode?: number }): Promise<{ fnArray: ArrayLike<number>; argsArray: unknown[] }>;
  getAnnotations(params?: { intent?: string }): Promise<unknown[]>;
}

export interface PdfDocLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
}

function numList(value: unknown): number[] {
  if (Array.isArray(value)) return value.filter((n): n is number => typeof n === "number");
  if (value && typeof value === "object" && typeof (value as ArrayLike<number>).length === "number") {
    return Array.from(value as ArrayLike<number>).filter((n) => typeof n === "number");
  }
  return [];
}

function asRect(value: unknown): Rect | null {
  const n = numList(value);
  if (n.length < 4) return null;
  const x = Math.min(n[0], n[2]);
  const y = Math.min(n[1], n[3]);
  return { x, y, width: Math.abs(n[2] - n[0]), height: Math.abs(n[3] - n[1]) };
}

function asRgb(color: unknown): { r: number; g: number; b: number } | null {
  let r: number;
  let g: number;
  let b: number;
  if (Array.isArray(color)) {
    r = color[0];
    g = color[1];
    b = color[2];
  } else if (color && typeof color === "object") {
    const c = color as Record<number, number>;
    r = c[0];
    g = c[1];
    b = c[2];
  } else {
    return null;
  }
  if (![r, g, b].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  if (r > 1 || g > 1 || b > 1) return { r: r / 255, g: g / 255, b: b / 255 };
  return { r, g, b };
}

function quadsOrRect(quads: unknown, fallback: Rect): Pt[][] {
  const n = numList(quads);
  if (n.length < 8) return [rectToPoly(fallback)];
  const polys: Pt[][] = [];
  for (let i = 0; i + 7 < n.length; i += 8) {
    const hull = convexHull([
      { x: n[i], y: n[i + 1] },
      { x: n[i + 2], y: n[i + 3] },
      { x: n[i + 4], y: n[i + 5] },
      { x: n[i + 6], y: n[i + 7] },
    ]);
    if (hull.length >= 3) polys.push(hull);
  }
  return polys.length ? polys : [rectToPoly(fallback)];
}

function annotationCovers(annots: unknown[]): Cover[] {
  const covers: Cover[] = [];
  annots.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const a = raw as Record<string, unknown>;
    const subtype = String(a.subtype ?? "").toLowerCase();
    const isRedact = subtype === "redact";
    const isSquare = subtype === "square";
    const isHighlight = subtype === "highlight";
    if (!isRedact && !isSquare && !isHighlight) return;
    const rect = asRect(a.rect);
    if (!rect) return;
    const rgb = asRgb(a.color);
    const lum = rgb ? luminance(rgb.r, rgb.g, rgb.b) : 0;
    if (!isRedact && (!rgb || lum >= DARK_LUMINANCE)) return;
    for (const polygon of quadsOrRect(a.quadPoints, rect)) {
      const box = aabb(polygon);
      if (box.width * box.height < MIN_COVER_AREA) continue;
      covers.push({
        kind: "annotation",
        paintIndex: 1_000_000_000 + index,
        polygon,
        rect: box,
        luminance: lum,
      });
    }
  });
  return covers;
}

function textRuns(items: unknown[], paint: number[]): TextRun[] {
  const runs: TextRun[] = [];
  let itemIndex = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== "object" || !("str" in item)) continue;
    const rec = item as { str?: unknown; width?: unknown; height?: unknown; transform?: unknown };
    if (typeof rec.str !== "string" || !rec.str) continue;
    const transform = numList(rec.transform);
    if (transform.length < 6) continue;
    runs.push({
      str: rec.str,
      width: typeof rec.width === "number" ? rec.width : 0,
      height: typeof rec.height === "number" ? rec.height : 0,
      transform: transform.slice(0, 6) as Mat,
      paintIndex: paint[itemIndex] ?? 0,
      itemIndex,
    });
    itemIndex += 1;
  }
  return runs;
}

function toCover(walked: WalkedCover): Cover {
  return {
    kind: walked.kind,
    paintIndex: walked.paintIndex,
    polygon: walked.polygon,
    rect: walked.rect,
    luminance: walked.luminance,
  };
}

export async function auditPage(page: PdfPageLike, pageNumber: number): Promise<PageAudit> {
  const viewport = page.getViewport({ scale: 1 });
  const [textContent, opList, annots] = await Promise.all([
    page.getTextContent({ disableNormalization: true }),
    page.getOperatorList({ annotationMode: ANNOTATION_MODE_DISABLE }),
    page.getAnnotations({ intent: "any" }),
  ]);
  const walked = walkOperatorList(opList);
  const strings: string[] = [];
  for (const item of textContent.items) {
    if (item && typeof item === "object" && "str" in item && typeof (item as { str: unknown }).str === "string") {
      const str = (item as { str: string }).str;
      if (str) strings.push(str);
    }
  }
  const paint = matchPaintIndices(strings, walked.textPaints);
  const runs = textRuns(textContent.items, paint);
  const covers = [...walked.covers.map(toCover), ...annotationCovers(annots)];
  const leaks = findLeaks(runs, covers, pageNumber);
  return {
    page: pageNumber,
    width: viewport.width,
    height: viewport.height,
    leaks,
    covers,
    coverCount: covers.length,
  };
}

export async function auditDocument(doc: PdfDocLike): Promise<AuditReport> {
  const pages: PageAudit[] = [];
  for (let n = 1; n <= doc.numPages; n++) pages.push(await auditPage(await doc.getPage(n), n));
  const leaks = pages.flatMap((p) => p.leaks);
  return { pageCount: doc.numPages, leakCount: leaks.length, pages, leaks };
}
