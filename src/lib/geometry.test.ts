import { apply, clipPolygon, coverage, cmykToRgb, ensureCCW, IDENTITY, joinGlyphs, luminance, multiply, rectToPoly, splitGlyphs, type Glyph } from "./geometry";
import type { TextRun } from "./types";

const horiz = (str: string, x: number, y: number, size: number, width: number, paint = 1, item = 0): TextRun => ({
  str,
  width,
  height: size,
  transform: [size, 0, 0, size, x, y],
  paintIndex: paint,
  itemIndex: item,
});

describe("matrices", () => {
  it("scales then translates when the translation is the parent", () => {
    const scale: [number, number, number, number, number, number] = [2, 0, 0, 2, 0, 0];
    const move: [number, number, number, number, number, number] = [1, 0, 0, 1, 10, 20];
    const m = multiply(move, scale);
    expect(apply(m, 3, 4)).toEqual({ x: 16, y: 28 });
    expect(apply(IDENTITY, 3, 4)).toEqual({ x: 3, y: 4 });
  });
});

describe("coverage", () => {
  it("is 1 when the glyph sits inside a larger box", () => {
    const glyph = rectToPoly({ x: 0, y: 0, width: 10, height: 10 });
    const cover = rectToPoly({ x: -2, y: -2, width: 20, height: 20 });
    expect(coverage(glyph, cover)).toBeCloseTo(1, 5);
  });

  it("is the overlapping fraction, including a hair over and under one half", () => {
    const glyph = rectToPoly({ x: 0, y: 0, width: 10, height: 10 });
    expect(coverage(glyph, rectToPoly({ x: 4, y: -1, width: 10, height: 12 }))).toBeCloseTo(0.6, 5);
    expect(coverage(glyph, rectToPoly({ x: 5, y: -1, width: 10, height: 12 }))).toBeCloseTo(0.5, 5);
    expect(coverage(glyph, rectToPoly({ x: 6, y: -1, width: 10, height: 12 }))).toBeCloseTo(0.4, 5);
    expect(coverage(glyph, rectToPoly({ x: 30, y: 30, width: 5, height: 5 }))).toBe(0);
  });

  it("handles a rotated square covering itself", () => {
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 20 },
      { x: -10, y: 10 },
    ];
    const clipped = clipPolygon(ensureCCW(square), ensureCCW(square));
    expect(coverage(square, square)).toBeCloseTo(1, 4);
    expect(clipped.length).toBeGreaterThanOrEqual(3);
  });
});

describe("colors", () => {
  it("maps CMYK black to RGB black and gray to itself", () => {
    expect(cmykToRgb(0, 0, 0, 1)).toEqual({ r: 0, g: 0, b: 0 });
    expect(cmykToRgb(0, 0, 0, 0)).toEqual({ r: 1, g: 1, b: 1 });
    expect(luminance(0, 0, 0)).toBe(0);
    expect(luminance(1, 1, 1)).toBeCloseTo(1, 5);
    expect(luminance(0.2, 0.2, 0.2)).toBeCloseTo(0.2, 5);
  });
});

describe("splitGlyphs", () => {
  it("splits width evenly and keeps spaces", () => {
    const glyphs = splitGlyphs(horiz("Ab c", 0, 0, 10, 40));
    expect(glyphs.map((g) => g.ch)).toEqual(["A", "b", " ", "c"]);
    expect(glyphs[0].poly[0].y).toBeCloseTo(-2, 5);
    expect(glyphs[1].originX).toBeCloseTo(10, 5);
    expect(glyphs[3].originX).toBeCloseTo(30, 5);
    const box = glyphs[0].poly;
    const ys = box.map((p) => p.y);
    expect(Math.min(...ys)).toBeCloseTo(-2, 5);
    expect(Math.max(...ys)).toBeCloseTo(8, 5);
  });

  it("follows a 90 degree text matrix", () => {
    const run: TextRun = {
      str: "AB",
      width: 40,
      height: 10,
      transform: [0, 10, -10, 0, 100, 200],
      paintIndex: 2,
      itemIndex: 0,
    };
    const [a, b] = splitGlyphs(run);
    const xs = a.poly.map((p) => p.x);
    const ys = a.poly.map((p) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(92, 5);
    expect(Math.max(...xs)).toBeCloseTo(102, 5);
    expect(Math.min(...ys)).toBeCloseTo(200, 5);
    expect(Math.max(...ys)).toBeCloseTo(220, 5);
    expect(b.originY).toBeCloseTo(220, 5);
    expect(joinGlyphs([a, b])).toBe("AB");
  });

  it("returns nothing for an empty run", () => {
    expect(splitGlyphs(horiz("", 0, 0, 10, 0))).toEqual([]);
  });
});

describe("joinGlyphs", () => {
  it("preserves a skipped space and separates lines", () => {
    const top = splitGlyphs(horiz("A B", 0, 100, 10, 30, 1, 0)).filter((g) => g.ch !== " ");
    const bottom = splitGlyphs(horiz("CD", 0, 40, 10, 20, 1, 1));
    expect(joinGlyphs([...top, ...bottom])).toBe("A B\nCD");
  });

  it("joins two items on the same baseline in x order", () => {
    const right = splitGlyphs(horiz("right", 80, 10, 10, 40, 1, 1));
    const left = splitGlyphs(horiz("left", 0, 10, 10, 40, 1, 0));
    expect(joinGlyphs([...right, ...left])).toBe("left right");
  });

  it("inserts a space when a non-space character was not leaked", () => {
    const glyphs = splitGlyphs(horiz("ABC", 0, 0, 10, 30)).filter((g: Glyph) => g.ch !== "B");
    expect(joinGlyphs(glyphs)).toBe("A C");
  });
});
