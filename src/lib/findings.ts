import type { Rect } from "./types";

export type Severity = "high" | "medium" | "low";
export type Grade = "A" | "B" | "C" | "D" | "F";

export type FindingKind =
  | "redaction"
  | "hidden-text"
  | "off-page"
  | "tiny-text"
  | "metadata"
  | "attachment"
  | "annotation"
  | "form"
  | "javascript"
  | "link"
  | "revision"
  | "layer"
  | "exif"
  | "pii"
  | "signature";

export interface Finding {
  id: string;
  kind: FindingKind;
  severity: Severity;
  title: string;
  detail: string;
  why: string;
  page?: number;
  rect?: Rect;
}

export interface Score {
  letter: Grade;
  sentence: string;
}

const SENTENCE: Record<Grade, string> = {
  A: "Nothing private turned up.",
  B: "A few small traces. Worth a look before you send it.",
  C: "Some private details are still in this file.",
  D: "This file can leak something important.",
  F: "This file is leaking private information.",
};

/** A is empty. B is only low. C is medium without high. D is one high. F is more than one high. */
export function scoreFindings(findings: { severity: Severity }[]): Score {
  const high = findings.filter((f) => f.severity === "high").length;
  const medium = findings.filter((f) => f.severity === "medium").length;
  const letter: Grade = high > 1 ? "F" : high === 1 ? "D" : medium > 0 ? "C" : findings.length > 0 ? "B" : "A";
  return { letter, sentence: SENTENCE[letter] };
}

export function cleanSummary(before: Score, after: Score): string {
  if (after.letter === "A") return `${before.letter} became A. This copy looks clean.`;
  if (before.letter === after.letter) return `Still ${after.letter}. ${after.sentence}`;
  return `${before.letter} became ${after.letter}. ${after.sentence}`;
}

let nextId = 1;

export function finding(input: Omit<Finding, "id"> & { id?: string }): Finding {
  return { ...input, id: input.id ?? `${input.kind}-${nextId++}` };
}

export function truncate(value: string, max = 180): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}
