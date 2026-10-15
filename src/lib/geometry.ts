import type { Mat, Pt, Rect, TextRun } from "./types";

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** `result` applies `child` first, then `parent` (PDF `cm` concatenation). */
export function multiply(parent: Mat, child: Mat): Mat {
  const [a1, b1, c1, d1, e1, f1] = parent;
  const [a2, b2, c2, d2, e2, f2] = child;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export function apply(m: Mat, x: number, y: number): Pt {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

export function signedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return a / 2;
}

export function polygonArea(pts: Pt[]): number {
  return Math.abs(signedArea(pts));
}

export function ensureCCW(pts: Pt[]): Pt[] {
  return signedArea(pts) < 0 ? [...pts].reverse() : pts.slice();
}

export function aabb(pts: Pt[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!pts.length) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function rectToPoly(rect: Rect): Pt[] {
  const { x, y, width, height } = rect;
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function inside(p: Pt, a: Pt, b: Pt): boolean {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= -1e-9;
}

function segmentHit(p: Pt, q: Pt, a: Pt, b: Pt): Pt {
  const rx = q.x - p.x;
  const ry = q.y - p.y;
  const sx = b.x - a.x;
  const sy = b.y - a.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return { x: q.x, y: q.y };
  const t = ((a.x - p.x) * sy - (a.y - p.y) * sx) / denom;
  return { x: p.x + t * rx, y: p.y + t * ry };
}

/** Clip `subject` to the convex `clip` polygon. Both should be CCW. */
export function clipPolygon(subject: Pt[], clip: Pt[]): Pt[] {
  let output = subject;
  for (let i = 0; i < clip.length; i++) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    const input = output;
    output = [];
    if (!input.length) break;
    for (let j = 0; j < input.length; j++) {
      const p = input[j];
      const q = input[(j + 1) % input.length];
      const pin = inside(p, a, b);
      const qin = inside(q, a, b);
      if (pin && qin) output.push(q);
      else if (pin && !qin) output.push(segmentHit(p, q, a, b));
      else if (!pin && qin) {
        output.push(segmentHit(p, q, a, b));
        output.push(q);
      }
    }
  }
  return output;
}

/** Fraction of `glyph` covered by `cover`, both simple polygons. */
export function coverage(glyph: Pt[], cover: Pt[]): number {
  if (glyph.length < 3 || cover.length < 3) return 0;
  const gArea = polygonArea(glyph);
  if (gArea < 1e-8) return 0;
  if (!rectsOverlap(aabb(glyph), aabb(cover))) return 0;
  const inter = clipPolygon(ensureCCW(glyph), ensureCCW(cover));
  if (inter.length < 3) return 0;
  return Math.min(1, polygonArea(inter) / gArea);
}

export function convexHull(points: Pt[]): Pt[] {
  const pts = points
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((p, q) => p.x - q.x || p.y - q.y);
  if (pts.length <= 1) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export function luminance(r: number, g: number, b: number): number {
  // The coefficients sum to 1, so a gray is its own luminance. Multiplying
  // the channels separately drifts just under the white threshold.
  if (r === g && g === b) return r;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function cmykToRgb(c: number, m: number, y: number, k: number): { r: number; g: number; b: number } {
  return { r: (1 - c) * (1 - k), g: (1 - m) * (1 - k), b: (1 - y) * (1 - k) };
}

export interface Glyph {
  ch: string;
  itemIndex: number;
  charIndex: number;
  itemChars: string[];
  paintIndex: number;
  poly: Pt[];
  originX: number;
  originY: number;
  height: number;
  angle: number;
}

/**
 * Split a text run into one box per code point.
 * Width is shared equally. The box sits on the baseline: 80% above, 20% below,
 * along the text matrix's y axis so rotated runs stay attached to the glyphs.
 */
export function splitGlyphs(run: TextRun): Glyph[] {
  const chars = [...run.str];
  const n = chars.length;
  if (!n || !(run.width > 0)) return [];
  const [a, b, c, d, e, f] = run.transform;
  const xLen = Math.hypot(a, b);
  const yLen = Math.hypot(c, d);
  const ux = xLen > 1e-9 ? a / xLen : 1;
  const uy = xLen > 1e-9 ? b / xLen : 0;
  const vx = yLen > 1e-9 ? c / yLen : -uy;
  const vy = yLen > 1e-9 ? d / yLen : ux;
  const height = run.height > 0 ? run.height : yLen > 0 ? yLen : 1;
  const advance = run.width / n;
  const descent = height * 0.2;
  const glyphs: Glyph[] = [];
  for (let i = 0; i < n; i++) {
    const ox = e + ux * advance * i;
    const oy = f + uy * advance * i;
    const bl = { x: ox - vx * descent, y: oy - vy * descent };
    const br = { x: bl.x + ux * advance, y: bl.y + uy * advance };
    const tr = { x: br.x + vx * height, y: br.y + vy * height };
    const tl = { x: bl.x + vx * height, y: bl.y + vy * height };
    glyphs.push({
      ch: chars[i],
      itemIndex: run.itemIndex,
      charIndex: i,
      itemChars: chars,
      paintIndex: run.paintIndex,
      poly: [bl, br, tr, tl],
      originX: ox,
      originY: oy,
      height,
      angle: Math.atan2(uy, ux),
    });
  }
  return glyphs;
}

function piece(glyphs: Glyph[]): string {
  let s = "";
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i];
    if (i > 0) {
      const prev = glyphs[i - 1];
      const gap = g.charIndex - prev.charIndex;
      if (gap > 1) {
        const skipped = g.itemChars.slice(prev.charIndex + 1, g.charIndex).join("");
        s += skipped.trim() === "" ? skipped : " ";
      }
    }
    s += g.ch;
  }
  return s;
}

/** Reading order: lines from top to bottom, and left to right within a line. Rotated runs stay intact. */
export function joinGlyphs(glyphs: Glyph[]): string {
  if (!glyphs.length) return "";
  const byItem = new Map<number, Glyph[]>();
  for (const g of glyphs) {
    const list = byItem.get(g.itemIndex);
    if (list) list.push(g);
    else byItem.set(g.itemIndex, [g]);
  }
  interface Run {
    glyphs: Glyph[];
    baselineX: number;
    baselineY: number;
    height: number;
    angle: number;
  }
  const runs: Run[] = [];
  for (const list of byItem.values()) {
    list.sort((a, b) => a.charIndex - b.charIndex);
    const first = list[0];
    runs.push({
      glyphs: list,
      baselineX: first.originX,
      baselineY: first.originY,
      height: first.height,
      angle: first.angle,
    });
  }
  const lines: Run[][] = [];
  const sorted = [...runs].sort((a, b) => b.baselineY - a.baselineY || a.baselineX - b.baselineX);
  for (const run of sorted) {
    const line = lines.find((group) => {
      const ref = group[0];
      const flat = Math.abs(ref.angle) < 0.5 && Math.abs(run.angle) < 0.5;
      return flat && Math.abs(ref.baselineY - run.baselineY) <= Math.max(ref.height, run.height) * 0.6;
    });
    if (line) line.push(run);
    else lines.push([run]);
  }
  const text = lines
    .map((line) => {
      line.sort((a, b) => a.baselineX - b.baselineX);
      return line
        .map((run) => piece(run.glyphs))
        .filter((part) => part.length > 0)
        .join(" ");
    })
    .filter((line) => line.trim().length > 0)
    .join("\n");
  return text.trim();
}
