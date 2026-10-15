/** A point in PDF user space (origin at the bottom left, y up). */
export interface Pt {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 6-tuple [a, b, c, d, e, f]: x' = a*x + c*y + e, y' = b*x + d*y + f. */
export type Mat = [number, number, number, number, number, number];

export type CoverKind = "dark" | "white" | "annotation";

export interface Cover {
  kind: CoverKind;
  /** Operator index. Annotations use a value past the end of the content stream. */
  paintIndex: number;
  polygon: Pt[];
  rect: Rect;
  luminance: number;
}

export interface Leak {
  page: number;
  text: string;
  kind: CoverKind;
  rect: Rect;
  polygon: Pt[];
}

export interface PageAudit {
  page: number;
  width: number;
  height: number;
  leaks: Leak[];
  /** Every dark box, whiteout, and qualifying annotation on the page. */
  covers: Cover[];
  coverCount: number;
}

export interface AuditReport {
  pageCount: number;
  leakCount: number;
  pages: PageAudit[];
  leaks: Leak[];
}

export interface TextRun {
  str: string;
  width: number;
  height: number;
  transform: Mat;
  paintIndex: number;
  itemIndex: number;
}
