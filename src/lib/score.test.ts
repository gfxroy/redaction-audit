import { cleanSummary, scoreFindings } from "./findings";

describe("scoreFindings", () => {
  it("grades from the worst thing in the file", () => {
    expect(scoreFindings([]).letter).toBe("A");
    expect(scoreFindings([{ severity: "low" }]).letter).toBe("B");
    expect(scoreFindings([{ severity: "low" }, { severity: "low" }]).letter).toBe("B");
    expect(scoreFindings([{ severity: "medium" }]).letter).toBe("C");
    expect(scoreFindings([{ severity: "high" }]).letter).toBe("D");
    expect(scoreFindings([{ severity: "high" }, { severity: "high" }]).letter).toBe("F");
    expect(scoreFindings([{ severity: "high" }, { severity: "medium" }]).letter).toBe("D");
  });

  it("uses a short sentence a person can read", () => {
    expect(scoreFindings([]).sentence).toBe("Nothing private turned up.");
    expect(scoreFindings([{ severity: "high" }, { severity: "high" }]).sentence).toMatch(/leaking/i);
  });
});

describe("cleanSummary", () => {
  it("says when the copy looks clean", () => {
    const before = scoreFindings([{ severity: "high" }, { severity: "high" }]);
    const after = scoreFindings([]);
    expect(cleanSummary(before, after)).toBe("F became A. This copy looks clean.");
  });
});
