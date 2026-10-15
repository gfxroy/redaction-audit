import { aabb, apply, cmykToRgb, IDENTITY, luminance, multiply, polygonArea } from "./geometry";
import type { Mat, Pt, Rect } from "./types";

/**
 * pdf.js operator ids. A test checks these against the installed pdfjs-dist.
 * pdf.js 5 folds path painting into `constructPath`: args are
 * `[paintOp, [drawOps], minMax]`, where drawOps uses {@link DrawOPS}.
 * Older lists (and the synthetic tests) emit `constructPath` as
 * `[opCodes, coords, minMax]` followed by a separate fill.
 */
export const OPS = {
  setGState: 9,
  save: 10,
  restore: 11,
  transform: 12,
  moveTo: 13,
  lineTo: 14,
  curveTo: 15,
  curveTo2: 16,
  curveTo3: 17,
  closePath: 18,
  rectangle: 19,
  stroke: 20,
  closeStroke: 21,
  fill: 22,
  eoFill: 23,
  fillStroke: 24,
  eoFillStroke: 25,
  closeFillStroke: 26,
  closeEOFillStroke: 27,
  endPath: 28,
  beginText: 31,
  endText: 32,
  setCharSpacing: 33,
  setWordSpacing: 34,
  setHScale: 35,
  setLeading: 36,
  setFont: 37,
  moveText: 40,
  setLeadingMoveText: 41,
  setTextMatrix: 42,
  nextLine: 43,
  showText: 44,
  showSpacedText: 45,
  nextLineShowText: 46,
  nextLineSetSpacingShowText: 47,
  setFillColorSpace: 51,
  setFillColor: 54,
  setFillColorN: 55,
  setFillGray: 57,
  setFillRGBColor: 59,
  setFillCMYKColor: 61,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  beginGroup: 76,
  endGroup: 77,
  constructPath: 91,
  setFillTransparent: 93,
} as const;

export const DrawOPS = {
  moveTo: 0,
  lineTo: 1,
  curveTo: 2,
  quadraticCurveTo: 3,
  closePath: 4,
} as const;

/** Below this, a fill is treated as a black redaction. */
export const DARK_LUMINANCE = 0.2;
/** At or above this, a fill is treated as whiteout. */
export const WHITE_LUMINANCE = 0.9;
export const MIN_COVER_AREA = 16;
/** Ignore rules and underlines. The shorter side of a 4-point shape. */
export const MIN_SHORT_SIDE = 2;

const FILL_OPS = new Set<number>([
  OPS.fill,
  OPS.eoFill,
  OPS.fillStroke,
  OPS.eoFillStroke,
  OPS.closeFillStroke,
  OPS.closeEOFillStroke,
]);

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface WalkedCover {
  polygon: Pt[];
  rect: Rect;
  paintIndex: number;
  kind: "dark" | "white";
  luminance: number;
}

export interface TextPaint {
  paintIndex: number;
  text: string;
  x: number;
  y: number;
}

interface GState {
  ctm: Mat;
  fill: Rgb | null;
  fillAlpha: number;
  textMatrix: Mat;
  lineMatrix: Mat;
  fontSize: number;
  hScale: number;
  leading: number;
  charSpacing: number;
  wordSpacing: number;
  textRise: number;
  fillSpace: "gray" | "rgb" | "cmyk" | "other";
}

function cloneState(s: GState): GState {
  return {
    ...s,
    ctm: [...s.ctm] as Mat,
    textMatrix: [...s.textMatrix] as Mat,
    lineMatrix: [...s.lineMatrix] as Mat,
    fill: s.fill ? { ...s.fill } : null,
  };
}

function initialState(): GState {
  return {
    ctm: [...IDENTITY] as Mat,
    fill: { r: 0, g: 0, b: 0 },
    fillAlpha: 1,
    textMatrix: [...IDENTITY] as Mat,
    lineMatrix: [...IDENTITY] as Mat,
    fontSize: 1,
    hScale: 1,
    leading: 0,
    charSpacing: 0,
    wordSpacing: 0,
    textRise: 0,
    fillSpace: "gray",
  };
}

function isArrayLike(value: unknown): value is ArrayLike<number> {
  return !!value && typeof value === "object" && typeof (value as ArrayLike<number>).length === "number";
}

function readMatrix(args: unknown[]): Mat | null {
  if (args.length >= 6 && args.slice(0, 6).every((v) => typeof v === "number")) {
    return args.slice(0, 6) as Mat;
  }
  const first = args[0];
  if (isArrayLike(first) && first.length >= 6 && typeof first[0] === "number") {
    return [first[0], first[1], first[2], first[3], first[4], first[5]];
  }
  return null;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseHexColor(value: string): Rgb | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  const n = parseInt(hex, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

function colorFromArgs(args: unknown[]): Rgb | null {
  if (args.length === 1 && typeof args[0] === "string") {
    if (args[0] === "transparent") return null;
    return parseHexColor(args[0]);
  }
  if (args.length >= 3 && args.slice(0, 3).every((v) => typeof v === "number")) {
    return { r: num(args[0]), g: num(args[1]), b: num(args[2]) };
  }
  return null;
}

function flattenCubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, steps: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    pts.push({
      x: mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
      y: mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y,
    });
  }
  return pts;
}

function flattenQuad(p0: Pt, p1: Pt, p2: Pt, steps: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    pts.push({
      x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
      y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
    });
  }
  return pts;
}

interface PathBuilder {
  subpaths: Pt[][];
  current: Pt[] | null;
  cx: number;
  cy: number;
}

function builder(): PathBuilder {
  return { subpaths: [], current: null, cx: 0, cy: 0 };
}

function moveTo(path: PathBuilder, ctm: Mat, x: number, y: number) {
  path.cx = x;
  path.cy = y;
  path.current = [apply(ctm, x, y)];
  path.subpaths.push(path.current);
}

function lineTo(path: PathBuilder, ctm: Mat, x: number, y: number) {
  path.cx = x;
  path.cy = y;
  if (!path.current) moveTo(path, ctm, x, y);
  else path.current.push(apply(ctm, x, y));
}

function curveTo(path: PathBuilder, ctm: Mat, x1: number, y1: number, x2: number, y2: number, x: number, y: number) {
  const start = { x: path.cx, y: path.cy };
  if (!path.current) moveTo(path, ctm, start.x, start.y);
  const local = flattenCubic(start, { x: x1, y: y1 }, { x: x2, y: y2 }, { x, y }, 6);
  for (const p of local) path.current!.push(apply(ctm, p.x, p.y));
  path.cx = x;
  path.cy = y;
}

function quadTo(path: PathBuilder, ctm: Mat, x1: number, y1: number, x: number, y: number) {
  const start = { x: path.cx, y: path.cy };
  if (!path.current) moveTo(path, ctm, start.x, start.y);
  const local = flattenQuad(start, { x: x1, y: y1 }, { x, y }, 6);
  for (const p of local) path.current!.push(apply(ctm, p.x, p.y));
  path.cx = x;
  path.cy = y;
}

/** pdf.js 5 draw-op buffer, coordinates still in the current user space. */
export function parseDrawOps(buf: ArrayLike<number>, ctm: Mat): Pt[][] {
  const path = builder();
  for (let i = 0; i < buf.length; ) {
    const op = buf[i++];
    if (op === DrawOPS.moveTo) {
      if (i + 1 >= buf.length) break;
      moveTo(path, ctm, buf[i++], buf[i++]);
    } else if (op === DrawOPS.lineTo) {
      if (i + 1 >= buf.length) break;
      lineTo(path, ctm, buf[i++], buf[i++]);
    } else if (op === DrawOPS.curveTo) {
      if (i + 5 >= buf.length) break;
      curveTo(path, ctm, buf[i++], buf[i++], buf[i++], buf[i++], buf[i++], buf[i++]);
    } else if (op === DrawOPS.quadraticCurveTo) {
      if (i + 3 >= buf.length) break;
      quadTo(path, ctm, buf[i++], buf[i++], buf[i++], buf[i++]);
    } else if (op === DrawOPS.closePath) {
      // Fill closes implicitly. Keep the points.
    } else {
      break;
    }
  }
  return path.subpaths;
}

/** Legacy constructPath: PDF operator codes plus a flat coordinate list. */
export function parseLegacyPath(ops: ArrayLike<number>, coords: ArrayLike<number>, ctm: Mat): Pt[][] {
  const path = builder();
  let ci = 0;
  const take = () => (ci < coords.length ? coords[ci++] : 0);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op === OPS.moveTo) moveTo(path, ctm, take(), take());
    else if (op === OPS.lineTo) lineTo(path, ctm, take(), take());
    else if (op === OPS.curveTo) curveTo(path, ctm, take(), take(), take(), take(), take(), take());
    else if (op === OPS.curveTo2) {
      const x1 = path.cx;
      const y1 = path.cy;
      curveTo(path, ctm, x1, y1, take(), take(), take(), take());
    } else if (op === OPS.curveTo3) {
      const x = take();
      const y = take();
      const xe = take();
      const ye = take();
      curveTo(path, ctm, x, y, xe, ye, xe, ye);
    } else if (op === OPS.rectangle) {
      const x = take();
      const y = take();
      const w = take();
      const h = take();
      path.subpaths.push([
        apply(ctm, x, y),
        apply(ctm, x + w, y),
        apply(ctm, x + w, y + h),
        apply(ctm, x, y + h),
      ]);
      path.current = null;
      path.cx = x;
      path.cy = y;
    } else if (op === OPS.closePath) {
      // implicit on fill
    } else {
      break;
    }
  }
  return path.subpaths;
}

function shortSide(poly: Pt[]): number {
  if (poly.length < 2) return 0;
  const e1 = Math.hypot(poly[1].x - poly[0].x, poly[1].y - poly[0].y);
  if (poly.length < 3) return e1;
  const e2 = Math.hypot(poly[2].x - poly[1].x, poly[2].y - poly[1].y);
  return Math.min(e1, e2);
}

function consider(subpaths: Pt[][], state: GState, paintIndex: number, out: WalkedCover[]) {
  if (!state.fill || state.fillAlpha < 0.5) return;
  const lum = luminance(state.fill.r, state.fill.g, state.fill.b);
  let kind: "dark" | "white" | null = null;
  if (lum < DARK_LUMINANCE) kind = "dark";
  else if (lum >= WHITE_LUMINANCE) kind = "white";
  if (!kind) return;
  for (const poly of subpaths) {
    if (poly.length < 3) continue;
    const area = polygonArea(poly);
    if (area < MIN_COVER_AREA) continue;
    if (poly.length <= 4 && shortSide(poly) < MIN_SHORT_SIDE) continue;
    out.push({ polygon: poly, rect: aabb(poly), paintIndex, kind, luminance: lum });
  }
}

function glyphsText(glyphs: unknown): { text: string; glyphs: unknown[] } {
  const list = Array.isArray(glyphs) ? glyphs : [];
  let text = "";
  for (const g of list) {
    if (g && typeof g === "object" && "unicode" in g && typeof (g as { unicode: unknown }).unicode === "string") {
      text += (g as { unicode: string }).unicode;
    }
  }
  return { text, glyphs: list };
}

function advanceText(state: GState, glyphs: unknown[]) {
  let width = 0;
  for (const g of glyphs) {
    if (typeof g === "number") {
      width -= (g / 1000) * state.fontSize * state.hScale;
      continue;
    }
    if (g && typeof g === "object" && "width" in g && typeof (g as { width: unknown }).width === "number") {
      const gw = (g as { width: number }).width;
      const space = Boolean((g as { isSpace?: boolean }).isSpace);
      width += (gw / 1000) * state.fontSize * state.hScale + state.charSpacing + (space ? state.wordSpacing : 0);
    }
  }
  const m = state.textMatrix;
  state.textMatrix = [m[0], m[1], m[2], m[3], m[0] * width + m[4], m[1] * width + m[5]];
}

function translateLine(state: GState, tx: number, ty: number) {
  const m = state.lineMatrix;
  state.lineMatrix = [m[0], m[1], m[2], m[3], m[0] * tx + m[2] * ty + m[4], m[1] * tx + m[3] * ty + m[5]];
  state.textMatrix = [...state.lineMatrix] as Mat;
}

function textOrigin(state: GState): Pt {
  const local = apply(state.textMatrix, 0, state.textRise);
  return apply(state.ctm, local.x, local.y);
}

function isPdfjs5Construct(args: unknown[]): boolean {
  return typeof args[0] === "number" && Array.isArray(args[1]);
}

function isLegacyConstruct(args: unknown[]): boolean {
  return Array.isArray(args[0]) && isArrayLike(args[1]);
}

function applyGState(state: GState, args: unknown[]) {
  const list = args[0];
  if (!Array.isArray(list)) return;
  for (const entry of list) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [key, value] = entry;
    if (key === "ca" && typeof value === "number") state.fillAlpha = value;
  }
}

function setFillFromComponents(state: GState, args: unknown[]) {
  if (state.fillSpace === "cmyk" && args.length >= 4) {
    state.fill = cmykToRgb(num(args[0]), num(args[1]), num(args[2]), num(args[3]));
    return;
  }
  if (state.fillSpace === "rgb" && args.length >= 3) {
    state.fill = { r: num(args[0]), g: num(args[1]), b: num(args[2]) };
    return;
  }
  if (typeof args[0] === "number") {
    const g = num(args[0]);
    state.fill = { r: g, g, b: g };
  }
}

/**
 * Walk a pdf.js operator list. Returns filled dark and white covers in page
 * user space, plus show-text events in paint order.
 */
export function walkOperatorList(opList: { fnArray: ArrayLike<number>; argsArray: unknown[] }): {
  covers: WalkedCover[];
  textPaints: TextPaint[];
} {
  const covers: WalkedCover[] = [];
  const textPaints: TextPaint[] = [];
  let state = initialState();
  const stack: GState[] = [];
  let pending: Pt[][] = [];

  const save = () => {
    stack.push(state);
    state = cloneState(state);
  };
  const restore = () => {
    const prev = stack.pop();
    if (prev) state = prev;
    pending = [];
  };

  const show = (args: unknown[], paintIndex: number) => {
    const { text, glyphs } = glyphsText(args[0]);
    if (text) {
      const origin = textOrigin(state);
      textPaints.push({ paintIndex, text, x: origin.x, y: origin.y });
    }
    advanceText(state, glyphs);
  };

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i] | 0;
    const args = (opList.argsArray[i] ?? []) as unknown[];
    switch (fn) {
      case OPS.save:
        save();
        break;
      case OPS.restore:
        restore();
        break;
      case OPS.transform: {
        const m = readMatrix(args);
        if (m) state.ctm = multiply(state.ctm, m);
        break;
      }
      case OPS.setGState:
        applyGState(state, args);
        break;
      case OPS.setFillTransparent:
        state.fill = null;
        break;
      case OPS.setFillRGBColor: {
        const color = colorFromArgs(args);
        if (color) state.fill = color;
        state.fillSpace = "rgb";
        break;
      }
      case OPS.setFillGray: {
        if (typeof args[0] === "string") {
          const color = colorFromArgs(args);
          if (color) state.fill = color;
        } else {
          const g = num(args[0]);
          state.fill = { r: g, g, b: g };
        }
        state.fillSpace = "gray";
        break;
      }
      case OPS.setFillCMYKColor: {
        if (typeof args[0] === "string") {
          const color = colorFromArgs(args);
          if (color) state.fill = color;
        } else if (args.length >= 4) {
          state.fill = cmykToRgb(num(args[0]), num(args[1]), num(args[2]), num(args[3]));
        }
        state.fillSpace = "cmyk";
        break;
      }
      case OPS.setFillColorSpace: {
        const name = String(args[0] ?? "");
        if (/cmyk/i.test(name)) state.fillSpace = "cmyk";
        else if (/rgb/i.test(name)) state.fillSpace = "rgb";
        else if (/gray/i.test(name)) state.fillSpace = "gray";
        else state.fillSpace = "other";
        break;
      }
      case OPS.setFillColor:
      case OPS.setFillColorN:
        if (typeof args[0] === "string") {
          const color = colorFromArgs(args);
          state.fill = color;
        } else setFillFromComponents(state, args);
        break;
      case OPS.constructPath: {
        if (isPdfjs5Construct(args)) {
          const paint = args[0] as number;
          const buf = (args[1] as unknown[])[0];
          pending = [];
          if (isArrayLike(buf) && FILL_OPS.has(paint)) {
            consider(parseDrawOps(buf, state.ctm), state, i, covers);
          }
        } else if (isLegacyConstruct(args)) {
          pending = parseLegacyPath(args[0] as number[], args[1] as ArrayLike<number>, state.ctm);
        }
        break;
      }
      case OPS.rectangle: {
        const x = num(args[0]);
        const y = num(args[1]);
        const w = num(args[2]);
        const h = num(args[3]);
        pending.push([
          apply(state.ctm, x, y),
          apply(state.ctm, x + w, y),
          apply(state.ctm, x + w, y + h),
          apply(state.ctm, x, y + h),
        ]);
        break;
      }
      case OPS.moveTo:
        pending.push([apply(state.ctm, num(args[0]), num(args[1]))]);
        break;
      case OPS.lineTo: {
        const last = pending[pending.length - 1];
        if (last) last.push(apply(state.ctm, num(args[0]), num(args[1])));
        break;
      }
      case OPS.fill:
      case OPS.eoFill:
      case OPS.fillStroke:
      case OPS.eoFillStroke:
      case OPS.closeFillStroke:
      case OPS.closeEOFillStroke:
        consider(pending, state, i, covers);
        pending = [];
        break;
      case OPS.stroke:
      case OPS.closeStroke:
      case OPS.endPath:
        pending = [];
        break;
      case OPS.beginText:
        state.textMatrix = [...IDENTITY] as Mat;
        state.lineMatrix = [...IDENTITY] as Mat;
        break;
      case OPS.endText:
        break;
      case OPS.setFont:
        if (typeof args[1] === "number") state.fontSize = args[1];
        break;
      case OPS.setTextMatrix: {
        const m = readMatrix(args);
        if (m) {
          state.textMatrix = m;
          state.lineMatrix = [...m] as Mat;
        }
        break;
      }
      case OPS.moveText:
        translateLine(state, num(args[0]), num(args[1]));
        break;
      case OPS.setLeadingMoveText:
        state.leading = -num(args[1]);
        translateLine(state, num(args[0]), num(args[1]));
        break;
      case OPS.nextLine:
        translateLine(state, 0, -state.leading);
        break;
      case OPS.setLeading:
        state.leading = num(args[0]);
        break;
      case OPS.setHScale:
        state.hScale = num(args[0], 100) / 100;
        break;
      case OPS.setCharSpacing:
        state.charSpacing = num(args[0]);
        break;
      case OPS.setWordSpacing:
        state.wordSpacing = num(args[0]);
        break;
      case OPS.showText:
      case OPS.showSpacedText:
      case OPS.nextLineShowText:
      case OPS.nextLineSetSpacingShowText:
        if (fn === OPS.nextLineShowText || fn === OPS.nextLineSetSpacingShowText) translateLine(state, 0, -state.leading);
        show(args, i);
        break;
      case OPS.paintFormXObjectBegin: {
        save();
        const m = readMatrix(args);
        if (m) state.ctm = multiply(state.ctm, m);
        break;
      }
      case OPS.paintFormXObjectEnd:
        restore();
        break;
      case OPS.beginGroup:
        save();
        break;
      case OPS.endGroup:
        restore();
        break;
      default:
        break;
    }
  }
  return { covers, textPaints };
}

/**
 * Pair each text item with the showText that produced it.
 * One showText may be split across several items; items keep that paint index.
 */
function consumeJoined(str: string, events: TextPaint[], e: number, offset: number): { e: number; offset: number } | null {
  const first = events[e]?.text.slice(offset) ?? "";
  if (!first || !str.startsWith(first) || str.length === first.length) return null;
  let rest = str.slice(first.length);
  let ee = e + 1;
  let off = 0;
  while (rest.length) {
    const next = events[ee]?.text ?? "";
    if (!next) return null;
    if (rest.startsWith(next)) {
      rest = rest.slice(next.length);
      ee += 1;
      off = 0;
      continue;
    }
    if (next.startsWith(rest)) {
      off = rest.length;
      break;
    }
    return null;
  }
  return { e: ee, offset: off };
}

export function matchPaintIndices(items: string[], events: TextPaint[]): number[] {
  const out = new Array<number>(items.length).fill(0);
  let e = 0;
  let offset = 0;
  for (let i = 0; i < items.length; i++) {
    const str = items[i];
    if (!str) continue;
    let guard = 0;
    while (e < events.length && guard++ < events.length + 2) {
      const ev = events[e].text;
      const slice = ev.slice(offset);
      if (slice.startsWith(str)) {
        out[i] = events[e].paintIndex;
        offset += str.length;
        if (offset >= ev.length) {
          e += 1;
          offset = 0;
        }
        break;
      }
      // pdf.js glues adjacent showText runs on one line into a single item.
      const joined = consumeJoined(str, events, e, offset);
      if (joined) {
        out[i] = events[e].paintIndex;
        e = joined.e;
        offset = joined.offset;
        break;
      }
      e += 1;
      offset = 0;
    }
  }
  return out;
}
