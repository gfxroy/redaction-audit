import { WHITE_LUMINANCE, type TextPaint } from "./operators";
import type { Rect } from "./types";

export const TINY_FONT = 2;

export interface TextIssue {
  kind: "hidden-text" | "off-page" | "tiny-text";
  /** White fill, or rendering mode 3 (invisible). Set for hidden text. */
  reason?: "white" | "invisible";
  text: string;
  rect: Rect;
}

function box(paint: TextPaint): Rect {
  const height = paint.fontSize > 0 ? paint.fontSize : 1;
  const width = paint.width > 0 ? paint.width : Math.max(height, paint.text.length * height * 0.5);
  return { x: paint.x, y: paint.y - height * 0.2, width, height };
}

/**
 * White text, rendering mode 3, text fully outside the page, and type smaller than 2pt.
 * Off-page wins over hidden, and hidden wins over tiny, so one run is reported once.
 */
export function classifyText(paints: TextPaint[], page: { width: number; height: number }): TextIssue[] {
  const issues: TextIssue[] = [];
  for (const paint of paints) {
    const text = paint.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const rect = box(paint);
    const outside = rect.x + rect.width < -1 || rect.y + rect.height < -1 || rect.x > page.width + 1 || rect.y > page.height + 1;
    if (outside) {
      issues.push({ kind: "off-page", text, rect });
      continue;
    }
    if (paint.renderMode === 3) {
      issues.push({ kind: "hidden-text", reason: "invisible", text, rect });
      continue;
    }
    if (paint.luminance !== null && paint.luminance >= WHITE_LUMINANCE) {
      issues.push({ kind: "hidden-text", reason: "white", text, rect });
      continue;
    }
    if (paint.fontSize > 0 && paint.fontSize < TINY_FONT) issues.push({ kind: "tiny-text", text, rect });
  }
  return issues;
}
