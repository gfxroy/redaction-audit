import { classifyText } from "./textIssues";
import type { TextPaint } from "./operators";

function paint(over: Partial<TextPaint> = {}): TextPaint {
  return {
    paintIndex: 1,
    text: "secret",
    x: 10,
    y: 100,
    width: 40,
    fontSize: 12,
    luminance: 0,
    renderMode: 0,
    ...over,
  };
}

const page = { width: 612, height: 792 };

describe("classifyText", () => {
  it("flags white text, invisible text, tiny type, and text off the page", () => {
    const issues = classifyText(
      [
        paint({ text: "ghost", luminance: 1 }),
        paint({ text: "gone", renderMode: 3, luminance: 0 }),
        paint({ text: "speck", fontSize: 1 }),
        paint({ text: "outside", x: 900 }),
      ],
      page,
    );
    expect(issues.map((issue) => [issue.kind, issue.reason ?? "", issue.text])).toEqual([
      ["hidden-text", "white", "ghost"],
      ["hidden-text", "invisible", "gone"],
      ["tiny-text", "", "speck"],
      ["off-page", "", "outside"],
    ]);
  });

  it("lets off-page win over white, and skips a normal run", () => {
    const issues = classifyText([paint({ text: "out", x: -80, luminance: 1 }), paint({ text: "visible" })], page);
    expect(issues.map((issue) => issue.kind)).toEqual(["off-page"]);
  });

  it("treats 2pt type as readable", () => {
    expect(classifyText([paint({ fontSize: 2 })], page)).toEqual([]);
  });
});
