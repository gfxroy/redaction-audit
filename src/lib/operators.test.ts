import { DrawOPS, DARK_LUMINANCE, matchPaintIndices, OPS, WHITE_LUMINANCE, walkOperatorList } from "./operators";

const list = (fnArray: number[], argsArray: unknown[]) => walkOperatorList({ fnArray, argsArray });

describe("walkOperatorList", () => {
  it("reads a legacy constructPath rectangle and a following fill", () => {
    const { covers } = list(
      [OPS.setFillRGBColor, OPS.constructPath, OPS.fill],
      [["#000000"], [[OPS.rectangle], [10, 20, 30, 40], null], []],
    );
    expect(covers).toHaveLength(1);
    expect(covers[0].kind).toBe("dark");
    expect(covers[0].rect.x).toBeCloseTo(10, 4);
    expect(covers[0].rect.y).toBeCloseTo(20, 4);
    expect(covers[0].rect.width).toBeCloseTo(30, 4);
    expect(covers[0].rect.height).toBeCloseTo(40, 4);
    expect(covers[0].paintIndex).toBe(2);
  });

  it("reads a pdf.js 5 constructPath, including translation", () => {
    const buf = [DrawOPS.moveTo, 0, 0, DrawOPS.lineTo, 40, 0, DrawOPS.lineTo, 40, 15, DrawOPS.lineTo, 0, 15, DrawOPS.closePath];
    const { covers } = list(
      [OPS.setFillRGBColor, OPS.transform, OPS.constructPath],
      [["#000000"], [1, 0, 0, 1, 10, 50], [OPS.fill, [buf], [0, 0, 40, 15]]],
    );
    expect(covers).toHaveLength(1);
    expect(covers[0].rect).toMatchObject({ x: 10, y: 50, width: 40, height: 15 });
    expect(covers[0].paintIndex).toBe(2);
  });

  it("accepts a simple closed path that is not a rectangle operator", () => {
    const buf = [DrawOPS.moveTo, 0, 0, DrawOPS.lineTo, 50, 0, DrawOPS.lineTo, 50, 20, DrawOPS.lineTo, 0, 20, DrawOPS.closePath];
    const { covers } = list([OPS.constructPath], [[OPS.fill, [buf], null]]);
    expect(covers).toHaveLength(1);
    expect(covers[0].kind).toBe("dark");
    expect(covers[0].rect.width).toBeCloseTo(50, 4);
  });

  it("scales a rectangle by the CTM", () => {
    const buf = [DrawOPS.moveTo, 0, 0, DrawOPS.lineTo, 10, 0, DrawOPS.lineTo, 10, 5, DrawOPS.lineTo, 0, 5, DrawOPS.closePath];
    const { covers } = list(
      [OPS.transform, OPS.constructPath],
      [[2, 0, 0, 2, 10, 20], [OPS.fill, [buf], null]],
    );
    expect(covers[0].rect).toMatchObject({ x: 10, y: 20, width: 20, height: 10 });
  });

  it("classifies gray, CMYK, and RGB, and honors the luminance edges", () => {
    const rect = [[OPS.rectangle], [0, 0, 30, 10], null];
    const dark = list([OPS.setFillGray, OPS.constructPath, OPS.fill], [[0.19], rect, []]);
    const boundary = list([OPS.setFillGray, OPS.constructPath, OPS.fill], [[DARK_LUMINANCE], rect, []]);
    const white = list([OPS.setFillGray, OPS.constructPath, OPS.fill], [[WHITE_LUMINANCE], rect, []]);
    const notWhite = list([OPS.setFillGray, OPS.constructPath, OPS.fill], [[0.89], rect, []]);
    const cmyk = list([OPS.setFillCMYKColor, OPS.constructPath, OPS.fill], [[0, 0, 0, 1], rect, []]);
    const rgb = list([OPS.setFillRGBColor, OPS.constructPath, OPS.fill], [[1, 1, 1], rect, []]);
    expect(dark.covers[0].kind).toBe("dark");
    expect(boundary.covers).toHaveLength(0);
    expect(white.covers[0].kind).toBe("white");
    expect(notWhite.covers).toHaveLength(0);
    expect(cmyk.covers[0].kind).toBe("dark");
    expect(rgb.covers[0].kind).toBe("white");
  });

  it("restores fill color and ignores strokes and tiny marks", () => {
    const rect = (x: number) => [[OPS.rectangle], [x, 0, 20, 10], null];
    const { covers } = list(
      [OPS.save, OPS.setFillRGBColor, OPS.constructPath, OPS.fill, OPS.restore, OPS.constructPath, OPS.fill, OPS.constructPath, OPS.stroke, OPS.constructPath, OPS.fill],
      [
        [],
        ["#ffffff"],
        rect(0),
        [],
        [],
        rect(40),
        [],
        rect(80),
        [],
        [[OPS.rectangle], [0, 0, 1, 1], null],
        [],
      ],
    );
    expect(covers.map((c) => c.kind)).toEqual(["white", "dark"]);
  });

  it("tracks nested transforms with save and restore", () => {
    const buf = [DrawOPS.moveTo, 0, 0, DrawOPS.lineTo, 10, 0, DrawOPS.lineTo, 10, 10, DrawOPS.lineTo, 0, 10, DrawOPS.closePath];
    const { covers } = list(
      [OPS.transform, OPS.save, OPS.transform, OPS.constructPath, OPS.restore, OPS.constructPath],
      [
        [1, 0, 0, 1, 5, 5],
        [],
        [2, 0, 0, 2, 0, 0],
        [OPS.fill, [buf], null],
        [],
        [OPS.fill, [buf], null],
      ],
    );
    expect(covers[0].rect).toMatchObject({ x: 5, y: 5, width: 20, height: 20 });
    expect(covers[1].rect).toMatchObject({ x: 5, y: 5, width: 10, height: 10 });
  });

  it("records showText before a later fill, and not a stroke", () => {
    const buf = [DrawOPS.moveTo, 0, 0, DrawOPS.lineTo, 80, 0, DrawOPS.lineTo, 80, 20, DrawOPS.lineTo, 0, 20, DrawOPS.closePath];
    const glyphs = [{ unicode: "S", width: 500 }, { unicode: "E", width: 500 }];
    const walked = list(
      [OPS.beginText, OPS.setTextMatrix, OPS.showText, OPS.endText, OPS.constructPath],
      [[], [[1, 0, 0, 1, 12, 40]], [glyphs], [], [OPS.fill, [buf], null]],
    );
    expect(walked.textPaints).toEqual([{
      paintIndex: 2,
      text: "SE",
      x: 12,
      y: 40,
      width: 1,
      fontSize: 1,
      luminance: 0,
      renderMode: 0,
    }]);
    expect(walked.covers[0].paintIndex).toBeGreaterThan(walked.textPaints[0].paintIndex);
  });

  it("drops a translucent fill", () => {
    const buf = [DrawOPS.moveTo, 0, 0, DrawOPS.lineTo, 30, 0, DrawOPS.lineTo, 30, 10, DrawOPS.lineTo, 0, 10, DrawOPS.closePath];
    const { covers } = list(
      [OPS.setGState, OPS.constructPath],
      [[[["ca", 0.2]]], [OPS.fill, [buf], null]],
    );
    expect(covers).toHaveLength(0);
  });
});

describe("matchPaintIndices", () => {
  const event = (paintIndex: number, text: string) => ({
    paintIndex,
    text,
    x: 0,
    y: 0,
    width: 10,
    fontSize: 12,
    luminance: 0,
    renderMode: 0,
  });

  it("zips equal runs and shares an index when one showText is split", () => {
    expect(matchPaintIndices(["Hello", "World"], [event(4, "Hello"), event(9, "World")])).toEqual([4, 9]);
    expect(matchPaintIndices(["Hel", "lo"], [event(3, "Hello")])).toEqual([3, 3]);
    expect(matchPaintIndices(["Hello"], [event(1, "Nope"), event(4, "Hello")])).toEqual([4]);
    expect(matchPaintIndices(["Password: hunter2", "NOTALEAK"], [event(55, "Password: "), event(65, "hunter2"), event(93, "NOTALEAK")])).toEqual([55, 93]);
  });
});
