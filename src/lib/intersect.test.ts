import { rectToPoly, splitGlyphs } from "./geometry";
import { findLeaks } from "./intersect";
import type { Cover, TextRun } from "./types";

const run = (str: string, x: number, y: number, width: number, paint: number, item = 0): TextRun => ({
  str,
  width,
  height: 10,
  transform: [10, 0, 0, 10, x, y],
  paintIndex: paint,
  itemIndex: item,
});

function cover(partial: Partial<Cover> & Pick<Cover, "polygon" | "paintIndex" | "kind">): Cover {
  const xs = partial.polygon.map((p) => p.x);
  const ys = partial.polygon.map((p) => p.y);
  return {
    luminance: partial.kind === "white" ? 1 : 0,
    rect: {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    },
    ...partial,
  };
}

const box = (x: number, y: number, w: number, h: number) => rectToPoly({ x, y, width: w, height: h });

describe("findLeaks", () => {
  it("recovers text under a dark box drawn later", () => {
    const leaks = findLeaks(
      [run("SSN 123-45-6789", 72, 680, 128, 4)],
      [cover({ kind: "dark", paintIndex: 10, polygon: box(68, 676, 140, 24) })],
      1,
    );
    expect(leaks.map((l) => l.text)).toEqual(["SSN 123-45-6789"]);
    expect(leaks[0].kind).toBe("dark");
    expect(leaks[0].page).toBe(1);
  });

  it("does not flag text drawn on top of a box", () => {
    const leaks = findLeaks(
      [run("NOTALEAK", 76, 500, 64, 12)],
      [cover({ kind: "dark", paintIndex: 3, polygon: box(70, 494, 90, 20) })],
      1,
    );
    expect(leaks).toEqual([]);
  });

  it("requires more than half the glyph, and keeps a partial word", () => {
    const glyphsRun = run("AB", 0, 0, 20, 1);
    const justOver = findLeaks([glyphsRun], [cover({ kind: "dark", paintIndex: 5, polygon: box(4, -4, 10, 20) })], 1);
    const justUnder = findLeaks([glyphsRun], [cover({ kind: "dark", paintIndex: 5, polygon: box(5, -4, 5, 20) })], 1);
    const second = findLeaks([glyphsRun], [cover({ kind: "dark", paintIndex: 5, polygon: box(6, -4, 10, 20) })], 1);
    expect(justOver.map((l) => l.text)).toEqual(["A"]);
    expect(justUnder).toEqual([]);
    expect(second.map((l) => l.text)).toEqual(["B"]);
    expect(splitGlyphs(glyphsRun)).toHaveLength(2);
  });

  it("treats any annotation overlap as a cover, even when the fill is earlier", () => {
    const leaks = findLeaks(
      [run("AB", 0, 0, 20, 8)],
      [cover({ kind: "annotation", paintIndex: 1, polygon: box(8, -2, 4, 14) })],
      2,
    );
    expect(leaks.map((l) => l.text)).toEqual(["AB"]);
    expect(leaks[0].kind).toBe("annotation");
  });

  it("flags whiteout and assigns each character to the topmost box", () => {
    const white = findLeaks(
      [run("hunter2", 140, 560, 56, 2)],
      [cover({ kind: "white", paintIndex: 6, polygon: box(138, 554, 64, 20) })],
      1,
    );
    expect(white.map((l) => [l.text, l.kind])).toEqual([["hunter2", "white"]]);

    const leaks = findLeaks(
      [run("AB", 0, 0, 20, 1)],
      [
        cover({ kind: "dark", paintIndex: 3, polygon: box(-2, -4, 30, 20) }),
        cover({ kind: "dark", paintIndex: 7, polygon: box(10, -4, 12, 20) }),
      ],
      1,
    );
    expect(leaks.map((l) => l.text).sort()).toEqual(["A", "B"]);
  });

  it("recovers rotated text under an axis-aligned box", () => {
    const leaks = findLeaks(
      [
        {
          str: "ROTATED-SECRET",
          width: 80,
          height: 10,
          transform: [0, 10, -10, 0, 100, 200],
          paintIndex: 1,
          itemIndex: 0,
        },
      ],
      [cover({ kind: "dark", paintIndex: 4, polygon: box(80, 190, 30, 100) })],
      1,
    );
    expect(leaks.map((l) => l.text)).toEqual(["ROTATED-SECRET"]);
  });
});
