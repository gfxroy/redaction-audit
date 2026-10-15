import { auditDocument, type PdfDocLike } from "./audit";
import { finding, scoreFindings, truncate, type Finding, type Score } from "./findings";
import { coverage, rectToPoly } from "./geometry";
import { walkOperatorList } from "./operators";
import { findPii, piiCopy, type PiiHit } from "./pii";
import { scanStructure, type RevisionFile } from "./structure";
import { classifyText, type TextIssue } from "./textIssues";
import type { AuditReport, Cover, Rect } from "./types";

export interface ScanReport {
  findings: Finding[];
  pages: { page: number; width: number; height: number }[];
  revisions: RevisionFile[];
  score: Score;
  audit: AuditReport;
}

function numbers(value: unknown): number[] {
  if (Array.isArray(value)) return value.filter((n): n is number => typeof n === "number");
  if (value && typeof value === "object" && typeof (value as ArrayLike<number>).length === "number") {
    return Array.from(value as ArrayLike<number>).filter((n) => typeof n === "number");
  }
  return [];
}

function rectFromItem(item: object): Rect | undefined {
  const rec = item as { transform?: unknown; width?: unknown; height?: unknown };
  const t = numbers(rec.transform);
  if (t.length < 6) return undefined;
  const [a, b, c, d, e, f] = t;
  const height = Math.hypot(c, d) || Math.hypot(a, b) || (typeof rec.height === "number" ? rec.height : 0);
  const width = typeof rec.width === "number" && rec.width > 0 ? rec.width : Math.hypot(a, b);
  if (height <= 0 && width <= 0) return undefined;
  return { x: e, y: f - height * 0.2, width: Math.max(width, 1), height: Math.max(height, 1) };
}

function mostlyOnDark(rect: Rect, covers: Cover[]): boolean {
  const glyph = rectToPoly(rect);
  return covers.some((cover) => cover.kind === "dark" && coverage(glyph, cover.polygon) > 0.5);
}

function textFinding(issue: TextIssue, page: number): Finding {
  if (issue.kind === "off-page") {
    return finding({
      kind: "off-page",
      severity: "high",
      title: "Text sits outside the page",
      detail: truncate(issue.text),
      why: "It does not show on the page, but copying the text or searching the file still finds it.",
      page,
      rect: issue.rect,
    });
  }
  if (issue.kind === "tiny-text") {
    return finding({
      kind: "tiny-text",
      severity: "medium",
      title: "Text is too small to read",
      detail: truncate(issue.text),
      why: "Type this small is easy to miss, and it is still in the file.",
      page,
      rect: issue.rect,
    });
  }
  return finding({
    kind: "hidden-text",
    severity: "high",
    title: issue.reason === "white" ? "Text is written in white" : "Text is invisible",
    detail: truncate(issue.text),
    why: "It does not show on the page, but copying the text or searching the file still finds it.",
    page,
    rect: issue.rect,
  });
}

function piiFinding(hit: PiiHit, page: number, rect?: Rect): Finding {
  const copy = piiCopy(hit.kind);
  return finding({
    kind: "pii",
    severity: "high",
    title: copy.title,
    detail: hit.value,
    why: copy.why,
    page,
    rect,
  });
}

function preferLocatedPii(findings: Finding[]): Finding[] {
  const located = new Set(findings.filter((item) => item.kind === "pii" && item.rect).map((item) => item.detail));
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const item of findings) {
    if (item.kind !== "pii") {
      out.push(item);
      continue;
    }
    if (seen.has(item.detail)) continue;
    if (located.has(item.detail) && !item.rect) continue;
    seen.add(item.detail);
    out.push(item);
  }
  return out;
}

/** Redactions, hidden text, document secrets, and personal details in one report. */
export async function scanDocument(bytes: Uint8Array, doc: PdfDocLike): Promise<ScanReport> {
  const audit = await auditDocument(doc);
  const structure = await scanStructure(bytes);
  const findings: Finding[] = [...structure.findings];

  for (const leak of audit.leaks) {
    const title =
      leak.kind === "white"
        ? "A white box does not hide this"
        : leak.kind === "annotation"
          ? "A markup box does not hide this"
          : "A black box does not hide this";
    findings.push(finding({
      kind: "redaction",
      severity: "high",
      title,
      detail: truncate(leak.text),
      why: "The words are still stored under the box. Selecting the page can copy them.",
      page: leak.page,
      rect: leak.rect,
    }));
  }

  for (const pageAudit of audit.pages) {
    const page = await doc.getPage(pageAudit.page);
    const [opList, content] = await Promise.all([
      page.getOperatorList({ annotationMode: 0 }),
      page.getTextContent({ disableNormalization: true }),
    ]);
    const walked = walkOperatorList(opList);
    for (const issue of classifyText(walked.textPaints, { width: pageAudit.width, height: pageAudit.height })) {
      if (issue.kind === "hidden-text" && issue.reason !== "invisible" && mostlyOnDark(issue.rect, pageAudit.covers)) continue;
      findings.push(textFinding(issue, pageAudit.page));
    }
    const parts: string[] = [];
    const located: { text: string; rect?: Rect }[] = [];
    for (const item of content.items) {
      if (!item || typeof item !== "object" || !("str" in item)) continue;
      const str = (item as { str: unknown }).str;
      if (typeof str !== "string" || !str.trim()) continue;
      parts.push(str);
      const rect = rectFromItem(item);
      located.push(rect ? { text: str, rect } : { text: str });
    }
    for (const hit of findPii(parts.join("\n"))) {
      const home = located.find((part) => part.text.includes(hit.value));
      findings.push(piiFinding(hit, pageAudit.page, home?.rect));
    }
  }

  const merged = preferLocatedPii(findings);
  return {
    findings: merged,
    pages: audit.pages.map((page) => ({ page: page.page, width: page.width, height: page.height })),
    revisions: structure.revisions,
    score: scoreFindings(merged),
    audit,
  };
}
