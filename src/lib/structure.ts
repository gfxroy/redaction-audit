import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFPage,
} from "pdf-lib";
import { readExif } from "./exif";
import { finding, truncate, type Finding } from "./findings";
import { findPii, piiCopy } from "./pii";
import { earlierRevisions } from "./revisions";
import type { Rect } from "./types";

export interface RevisionFile {
  label: string;
  bytes: Uint8Array;
}

export interface StructureReport {
  findings: Finding[];
  revisions: RevisionFile[];
}

export interface SavedField {
  name: string;
  value: string;
  pageIndex: number;
  rect: Rect;
}

export interface SavedFile {
  name: string;
  data: Uint8Array;
}

export interface SavedScript {
  name: string;
  source: string;
}

export interface InfoSnapshot {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  created?: Date;
  modified?: Date;
  xmp?: Uint8Array;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function nameOf(obj: unknown): string {
  if (!(obj instanceof PDFName)) return "";
  const raw = obj.asString();
  return raw.startsWith("/") ? raw.slice(1) : raw;
}

export function textOf(obj: unknown): string {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.decodeText();
  if (obj instanceof PDFName) return nameOf(obj);
  return "";
}

function streamBytes(obj: unknown): Uint8Array | undefined {
  if (!(obj instanceof PDFStream) && !(obj instanceof PDFRawStream)) return undefined;
  try {
    return obj.getContents();
  } catch {
    return undefined;
  }
}

function looksTextual(bytes: Uint8Array): boolean {
  if (!bytes.length) return false;
  const n = Math.min(bytes.length, 4000);
  let printable = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) printable += 1;
  }
  return printable / n > 0.85;
}

function numOf(obj: unknown): number | undefined {
  if (obj instanceof PDFNumber) return obj.asNumber();
  return undefined;
}

export function rectOf(dict: PDFDict): Rect | undefined {
  const arr = dict.lookup(PDFName.of("Rect"));
  if (!(arr instanceof PDFArray) || arr.size() < 4) return undefined;
  const n = [0, 1, 2, 3].map((i) => numOf(arr.lookup(i)));
  if (n.some((v) => v === undefined)) return undefined;
  const [x1, y1, x2, y2] = n as number[];
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

function sameRef(a: unknown, b: unknown): boolean {
  return a instanceof PDFRef && b instanceof PDFRef && a.objectNumber === b.objectNumber && a.generationNumber === b.generationNumber;
}

interface NamePair {
  name: string;
  value: PDFDict | PDFStream | undefined;
}

function nameTree(node: unknown, out: NamePair[] = []): NamePair[] {
  if (!(node instanceof PDFDict)) return out;
  const names = node.lookup(PDFName.of("Names"));
  if (names instanceof PDFArray) {
    for (let i = 0; i + 1 < names.size(); i += 2) {
      const value = names.lookup(i + 1);
      const dict = value instanceof PDFDict || value instanceof PDFStream ? value : undefined;
      out.push({ name: textOf(names.lookup(i)), value: dict });
    }
  }
  const kids = node.lookup(PDFName.of("Kids"));
  if (kids instanceof PDFArray) {
    for (let i = 0; i < kids.size(); i++) nameTree(kids.lookup(i), out);
  }
  return out;
}

function namesDict(doc: PDFDocument): PDFDict | undefined {
  const names = doc.catalog.lookup(PDFName.of("Names"));
  return names instanceof PDFDict ? names : undefined;
}

export function deleteNameTree(doc: PDFDocument, key: string) {
  namesDict(doc)?.delete(PDFName.of(key));
  if (key === "EmbeddedFiles") doc.catalog.delete(PDFName.of("AF"));
}

function filtersOf(dict: PDFDict): string[] {
  const filter = dict.lookup(PDFName.of("Filter"));
  if (filter instanceof PDFName) return [nameOf(filter)];
  if (filter instanceof PDFArray) {
    const out: string[] = [];
    for (let i = 0; i < filter.size(); i++) {
      const item = filter.lookup(i);
      if (item instanceof PDFName) out.push(nameOf(item));
    }
    return out;
  }
  return [];
}

function fileBytes(spec: PDFDict): Uint8Array | undefined {
  const ef = spec.lookup(PDFName.of("EF"));
  if (!(ef instanceof PDFDict)) return undefined;
  const stream = ef.lookup(PDFName.of("F")) ?? ef.lookup(PDFName.of("UF"));
  return streamBytes(stream);
}

function fileName(spec: PDFDict, fallback = "attachment"): string {
  return textOf(spec.lookup(PDFName.of("UF"))) || textOf(spec.lookup(PDFName.of("F"))) || fallback;
}

export function collectAttachments(doc: PDFDocument): SavedFile[] {
  const out: SavedFile[] = [];
  const seen = new Set<string>();
  const push = (name: string, data: Uint8Array | undefined) => {
    if (!data || seen.has(name)) return;
    seen.add(name);
    out.push({ name, data });
  };
  const tree = namesDict(doc)?.lookup(PDFName.of("EmbeddedFiles"));
  for (const pair of nameTree(tree)) {
    if (pair.value instanceof PDFDict) push(pair.name || fileName(pair.value), fileBytes(pair.value));
  }
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annot = annots.lookup(i);
      if (!(annot instanceof PDFDict) || nameOf(annot.lookup(PDFName.of("Subtype"))) !== "FileAttachment") continue;
      const spec = annot.lookup(PDFName.of("FS"));
      if (spec instanceof PDFDict) push(fileName(spec, textOf(annot.lookup(PDFName.of("Contents"))) || "attachment"), fileBytes(spec));
    }
  }
  return out;
}

function scriptFrom(action: PDFDict): string {
  const js = action.lookup(PDFName.of("JS"));
  if (js instanceof PDFString || js instanceof PDFHexString) return js.decodeText();
  const stream = streamBytes(js);
  if (stream && looksTextual(stream)) return new TextDecoder().decode(stream);
  return "";
}

function walkActions(node: unknown, visit: (action: PDFDict) => void, seen: Set<unknown> = new Set()) {
  if (!node || seen.has(node)) return;
  if (node instanceof PDFArray) {
    seen.add(node);
    // A destination array is [page /Fit ...] and must not be followed into the page tree.
    if (node.size() > 1 && node.lookup(1) instanceof PDFName) return;
    for (let i = 0; i < node.size(); i++) walkActions(node.lookup(i), visit, seen);
    return;
  }
  if (!(node instanceof PDFDict)) return;
  seen.add(node);
  const subtype = nameOf(node.lookup(PDFName.of("S")));
  if (subtype || node.has(PDFName.of("JS")) || node.has(PDFName.of("URI"))) {
    visit(node);
    walkActions(node.lookup(PDFName.of("Next")), visit, seen);
    return;
  }
  for (const key of node.keys()) walkActions(node.lookup(key), visit, seen);
}

export function collectScripts(doc: PDFDocument): SavedScript[] {
  const out: SavedScript[] = [];
  const seen = new Set<string>();
  const push = (name: string, source: string) => {
    const text = source.trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    out.push({ name: name || `script-${out.length + 1}`, source: text });
  };
  const tree = namesDict(doc)?.lookup(PDFName.of("JavaScript"));
  for (const pair of nameTree(tree)) {
    if (pair.value instanceof PDFDict) push(pair.name, scriptFrom(pair.value));
  }
  const open = openActionScript(doc);
  if (open) push("OpenAction", open);
  walkActions(doc.catalog.lookup(PDFName.of("AA")), (action) => push("page-action", scriptFrom(action)));
  for (const page of doc.getPages()) {
    walkActions(page.node.lookup(PDFName.of("AA")), (action) => push("page-action", scriptFrom(action)));
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annot = annots.lookup(i);
      if (!(annot instanceof PDFDict)) continue;
      walkActions(annot.lookup(PDFName.of("A")), (action) => push("annotation", scriptFrom(action)));
      walkActions(annot.lookup(PDFName.of("AA")), (action) => push("annotation", scriptFrom(action)));
    }
  }
  return out;
}

export function openActionScript(doc: PDFDocument): string | null {
  const open = doc.catalog.lookup(PDFName.of("OpenAction"));
  if (!(open instanceof PDFDict)) return null;
  const source = scriptFrom(open);
  return source.trim() ? source : null;
}

export function readInfo(doc: PDFDocument): InfoSnapshot {
  const info: InfoSnapshot = {};
  const title = doc.getTitle();
  const author = doc.getAuthor();
  const subject = doc.getSubject();
  const keywords = doc.getKeywords();
  const creator = doc.getCreator();
  const producer = doc.getProducer();
  const created = doc.getCreationDate();
  const modified = doc.getModificationDate();
  if (title) info.title = title;
  if (author) info.author = author;
  if (subject) info.subject = subject;
  if (keywords) info.keywords = keywords;
  if (creator) info.creator = creator;
  if (producer) info.producer = producer;
  if (created) info.created = created;
  if (modified) info.modified = modified;
  const xmp = streamBytes(doc.catalog.lookup(PDFName.of("Metadata")));
  if (xmp?.length) info.xmp = xmp;
  return info;
}

export function writeInfo(doc: PDFDocument, info: InfoSnapshot) {
  if (info.title) doc.setTitle(info.title);
  if (info.author) doc.setAuthor(info.author);
  if (info.subject) doc.setSubject(info.subject);
  if (info.keywords) doc.setKeywords([info.keywords]);
  if (info.creator) doc.setCreator(info.creator);
  if (info.producer) doc.setProducer(info.producer);
  if (info.created) doc.setCreationDate(info.created);
  if (info.modified) doc.setModificationDate(info.modified);
  if (info.xmp) {
    const stream = doc.context.stream(info.xmp, { Type: "Metadata", Subtype: "XML" });
    doc.catalog.set(PDFName.of("Metadata"), doc.context.register(stream));
  }
}

function fieldWidgets(field: PDFDict): PDFDict[] {
  if (rectOf(field)) return [field];
  const kids = field.lookup(PDFName.of("Kids"));
  if (!(kids instanceof PDFArray)) return [];
  const widgets: PDFDict[] = [];
  for (let i = 0; i < kids.size(); i++) {
    const kid = kids.lookup(i);
    if (kid instanceof PDFDict && rectOf(kid)) widgets.push(kid);
  }
  return widgets;
}

function pageIndexOf(doc: PDFDocument, widget: PDFDict, fieldRef: unknown): number {
  const pages = doc.getPages();
  const parent = widget.lookup(PDFName.of("P"));
  for (let i = 0; i < pages.length; i++) {
    if (parent === pages[i].node) return i;
    const annots = pages[i].node.Annots();
    if (!annots) continue;
    for (let j = 0; j < annots.size(); j++) {
      if (sameRef(annots.get(j), fieldRef) || annots.lookup(j) === widget) return i;
    }
  }
  return 0;
}

function valueText(obj: unknown): string | null {
  if (obj instanceof PDFDict) return null;
  if (obj instanceof PDFArray) {
    const parts: string[] = [];
    for (let i = 0; i < obj.size(); i++) {
      const part = valueText(obj.lookup(i));
      if (part) parts.push(part);
    }
    return parts.length ? parts.join(", ") : null;
  }
  const text = textOf(obj).trim();
  if (!text || text === "Off") return null;
  return text;
}

function walkFieldArray(fields: PDFArray, visit: (field: PDFDict, ref: unknown) => void) {
  for (let i = 0; i < fields.size(); i++) {
    const field = fields.lookup(i);
    if (!(field instanceof PDFDict)) continue;
    visit(field, fields.get(i));
    const kids = field.lookup(PDFName.of("Kids"));
    if (!(kids instanceof PDFArray)) continue;
    const first = kids.lookup(0);
    if (first instanceof PDFDict && (first.has(PDFName.of("T")) || first.has(PDFName.of("Kids")) || first.has(PDFName.of("FT")))) {
      walkFieldArray(kids, visit);
    }
  }
}

export function collectTextFields(doc: PDFDocument): SavedField[] {
  const acro = doc.catalog.lookup(PDFName.of("AcroForm"));
  if (!(acro instanceof PDFDict)) return [];
  const fields = acro.lookup(PDFName.of("Fields"));
  if (!(fields instanceof PDFArray)) return [];
  const out: SavedField[] = [];
  walkFieldArray(fields, (field, ref) => {
    if (nameOf(field.lookup(PDFName.of("FT"))) === "Sig") return;
    if (field.lookup(PDFName.of("V")) instanceof PDFDict) return;
    const value = valueText(field.lookup(PDFName.of("V")));
    if (!value) return;
    const widget = fieldWidgets(field)[0] ?? field;
    const rect = rectOf(widget) ?? { x: 72, y: 72, width: 180, height: 18 };
    out.push({
      name: textOf(field.lookup(PDFName.of("T"))) || `field-${out.length + 1}`,
      value,
      pageIndex: pageIndexOf(doc, widget, ref),
      rect,
    });
  });
  return out;
}

function formatDay(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function formatPdfDate(raw: string): string {
  const match = /D:(\d{4})(\d{2})(\d{2})/.exec(raw);
  if (!match) return raw;
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return raw;
  return `${Number(match[3])} ${month} ${match[1]}`;
}

function isSig(obj: unknown): obj is PDFDict {
  if (!(obj instanceof PDFDict)) return false;
  if (nameOf(obj.lookup(PDFName.of("Type"))) === "Sig") return true;
  return obj.has(PDFName.of("ByteRange")) && obj.has(PDFName.of("Contents")) && obj.has(PDFName.of("SubFilter"));
}

function pushPii(bucket: { text: string; page?: number; rect?: Rect }[], text: string, page?: number, rect?: Rect) {
  const flat = text.trim();
  if (flat) bucket.push({ text: flat, page, rect });
}

/** Document-level privacy findings. Page text and redaction leaks are added by the scan. */
export async function scanStructure(bytes: Uint8Array): Promise<StructureReport> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const findings: Finding[] = [];
  const texts: { text: string; page?: number; rect?: Rect }[] = [];

  const info = readInfo(doc);
  const parts: string[] = [];
  if (info.title) parts.push(`Title: ${info.title}`);
  if (info.author) parts.push(`Author: ${info.author}`);
  if (info.subject) parts.push(`Subject: ${info.subject}`);
  if (info.keywords) parts.push(`Keywords: ${info.keywords}`);
  if (info.creator) parts.push(`Created with: ${info.creator}`);
  if (info.producer) parts.push(`Producer: ${info.producer}`);
  if (info.created) parts.push(`Created: ${formatDay(info.created)}`);
  if (info.modified) parts.push(`Changed: ${formatDay(info.modified)}`);
  const xmp = info.xmp ? new TextDecoder().decode(info.xmp) : "";
  const xmpIdentity = /dc:(creator|title|description|subject)/i.test(xmp);
  const identity = Boolean(info.author || info.title || info.subject || info.keywords || xmpIdentity);
  if (xmpIdentity && !info.author && !info.title && !info.subject) parts.push("Extra file info names a person or a title.");
  if (parts.length) {
    findings.push(finding({
      kind: "metadata",
      severity: identity ? "medium" : "low",
      title: "The file remembers who made it",
      detail: truncate(parts.join(" · ")),
      why: "Your name and the program that wrote the file travel with it when you email it.",
    }));
    for (const bit of [info.title, info.author, info.subject, info.keywords, info.creator, xmp]) {
      if (bit) pushPii(texts, bit);
    }
  }

  const seenFiles = new Set<string>();
  const addFile = (name: string, data: Uint8Array | undefined, page?: number, rect?: Rect) => {
    const label = name || "attachment";
    if (seenFiles.has(label)) return;
    seenFiles.add(label);
    findings.push(finding({
      kind: "attachment",
      severity: "high",
      title: "A file is attached",
      detail: truncate(label),
      why: "The attachment is a separate file. It can hold a spreadsheet, a photo, or another PDF.",
      page,
      rect,
    }));
    if (!data) return;
    const photo = readExif(data);
    if (photo?.gps) {
      findings.push(finding({
        kind: "exif",
        severity: "high",
        title: "A photo still has a location",
        detail: photo.gps.label,
        why: "The picture remembers where it was taken, even if you cropped it.",
        page,
      }));
    } else if (photo && (photo.camera || photo.date)) {
      findings.push(finding({
        kind: "exif",
        severity: "medium",
        title: "A photo still has camera details",
        detail: truncate([photo.camera, photo.date].filter(Boolean).join(" · ")),
        why: "Camera details can identify the device that took the picture.",
        page,
      }));
    }
    if (looksTextual(data)) pushPii(texts, new TextDecoder().decode(data), page, rect);
  };

  for (const [index, page] of doc.getPages().entries()) {
    const resources = page.node.Resources();
    const xobj = resources?.lookup(PDFName.of("XObject"));
    if (xobj instanceof PDFDict) {
      for (const key of xobj.keys()) {
        const stream = xobj.lookup(key);
        if (!(stream instanceof PDFStream)) continue;
        if (nameOf(stream.dict.lookup(PDFName.of("Subtype"))) !== "Image") continue;
        if (!filtersOf(stream.dict).includes("DCTDecode")) continue;
        const bytesOf = streamBytes(stream);
        if (!bytesOf) continue;
        const photo = readExif(bytesOf);
        if (!photo) continue;
        if (photo.gps) {
          findings.push(finding({
            kind: "exif",
            severity: "high",
            title: "A photo still has a location",
            detail: photo.gps.label,
            why: "The picture remembers where it was taken, even if you cropped it.",
            page: index + 1,
          }));
        } else if (photo.camera || photo.date) {
          findings.push(finding({
            kind: "exif",
            severity: "medium",
            title: "A photo still has camera details",
            detail: truncate([photo.camera, photo.date].filter(Boolean).join(" · ")),
            why: "Camera details can identify the device that took the picture.",
            page: index + 1,
          }));
        }
      }
    }

    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annot = annots.lookup(i);
      if (!(annot instanceof PDFDict)) continue;
      const subtype = nameOf(annot.lookup(PDFName.of("Subtype")));
      const rect = rectOf(annot);
      const contents = textOf(annot.lookup(PDFName.of("Contents"))).trim();
      if (subtype === "FileAttachment") {
        const spec = annot.lookup(PDFName.of("FS"));
        if (spec instanceof PDFDict) addFile(fileName(spec, contents || "attachment"), fileBytes(spec), index + 1, rect);
        else addFile(contents || "attachment", undefined, index + 1, rect);
      } else if (subtype === "Link") {
        walkActions(annot.lookup(PDFName.of("A")), (action) => {
          if (nameOf(action.lookup(PDFName.of("S"))) !== "URI") return;
          const uri = textOf(action.lookup(PDFName.of("URI"))).trim();
          if (!uri) return;
          findings.push(finding({
            kind: "link",
            severity: "medium",
            title: "This file links to a website",
            detail: truncate(uri),
            why: "Opening the link can tell that site you have this document.",
            page: index + 1,
            rect,
          }));
          pushPii(texts, uri, index + 1, rect);
        });
      } else if (subtype !== "Widget" && subtype !== "Popup") {
        if (contents) {
          findings.push(finding({
            kind: "annotation",
            severity: "medium",
            title: "Someone left a comment",
            detail: truncate(contents),
            why: "Comments are easy to miss when you read the page, and they are still in the file.",
            page: index + 1,
            rect,
          }));
          pushPii(texts, contents, index + 1, rect);
        } else if (subtype && subtype !== "Link") {
          findings.push(finding({
            kind: "annotation",
            severity: "low",
            title: "A mark is on the page",
            detail: subtype,
            why: "Comments are easy to miss when you read the page, and they are still in the file.",
            page: index + 1,
            rect,
          }));
        }
      }
    }
  }

  const embedded = namesDict(doc)?.lookup(PDFName.of("EmbeddedFiles"));
  for (const pair of nameTree(embedded)) {
    if (pair.value instanceof PDFDict) addFile(pair.name || fileName(pair.value), fileBytes(pair.value));
  }

  for (const script of collectScripts(doc)) {
    findings.push(finding({
      kind: "javascript",
      severity: "high",
      title: "This file can run a script",
      detail: truncate(script.source),
      why: "A script can change the file or send information when someone opens it.",
    }));
    pushPii(texts, script.source);
  }

  const acro = doc.catalog.lookup(PDFName.of("AcroForm"));
  if (acro instanceof PDFDict) {
    const fields = acro.lookup(PDFName.of("Fields"));
    if (fields instanceof PDFArray) {
      walkFieldArray(fields, (field, ref) => {
        const widget = fieldWidgets(field)[0] ?? field;
        const rect = rectOf(widget);
        const page = pageIndexOf(doc, widget, ref) + 1;
        const direct = field.lookup(PDFName.of("V"));
        if (nameOf(field.lookup(PDFName.of("FT"))) === "Sig" || isSig(direct)) {
          const sig = isSig(direct) ? direct : field;
          noteSignature(findings, sig, page);
          return;
        }
        const value = valueText(direct);
        if (!value) return;
        const name = textOf(field.lookup(PDFName.of("T")));
        findings.push(finding({
          kind: "form",
          severity: "high",
          title: "A form still has an answer",
          detail: truncate(name ? `${name}: ${value}` : value),
          why: "Form answers stay in the file after you print it or flatten the look of the page.",
          page,
          rect,
        }));
        pushPii(texts, value, page, rect);
      });
    }
  }

  noteLayers(doc, findings);

  const earlier = earlierRevisions(bytes);
  const revisions = earlier.map((chunk, index) => ({
    label: earlier.length > 1 ? `Earlier version ${index + 1}` : "Earlier version",
    bytes: chunk,
  }));
  if (revisions.length) {
    findings.push(finding({
      kind: "revision",
      severity: "high",
      title: "An older copy is still in this file",
      detail: "This PDF was saved on top of an earlier version. The older bytes are still at the start of the file.",
      why: "Deleting text in a later save does not always delete the first copy. Someone can open the earlier version and read it.",
    }));
  }

  for (const item of texts) {
    for (const hit of findPii(item.text)) {
      const copy = piiCopy(hit.kind);
      findings.push(finding({
        kind: "pii",
        severity: "high",
        title: copy.title,
        detail: hit.value,
        why: copy.why,
        page: item.page,
        rect: item.rect,
      }));
    }
  }

  return { findings: dedupe(findings), revisions };
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const item of findings) {
    if (item.kind === "pii" || item.kind === "javascript" || item.kind === "link" || item.kind === "exif") {
      const key = `${item.kind}:${item.detail}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(item);
  }
  return out;
}

function noteSignature(findings: Finding[], sig: PDFDict, page?: number) {
  const name = textOf(sig.lookup(PDFName.of("Name"))).trim();
  const when = formatPdfDate(textOf(sig.lookup(PDFName.of("M"))).trim());
  let detail = "A digital signature is attached.";
  if (name && when) detail = `Signed by ${name} on ${when}.`;
  else if (name) detail = `Signed by ${name}.`;
  else if (when) detail = `Signed on ${when}.`;
  findings.push(finding({
    kind: "signature",
    severity: "medium",
    title: "This file is signed",
    detail,
    why: "The signature names a person and a time. Removing pages does not always remove that.",
    page,
  }));
}

function noteLayers(doc: PDFDocument, findings: Finding[]) {
  const props = doc.catalog.lookup(PDFName.of("OCProperties"));
  if (!(props instanceof PDFDict)) return;
  const ocgs = props.lookup(PDFName.of("OCGs"));
  if (!(ocgs instanceof PDFArray)) return;
  const off = new Set<string>();
  const defaults = props.lookup(PDFName.of("D"));
  if (defaults instanceof PDFDict) {
    const list = defaults.lookup(PDFName.of("OFF"));
    if (list instanceof PDFArray) {
      for (let i = 0; i < list.size(); i++) {
        const raw = list.get(i);
        if (raw instanceof PDFRef) off.add(String(raw.objectNumber));
      }
    }
  }
  for (let i = 0; i < ocgs.size(); i++) {
    const ocg = ocgs.lookup(i);
    if (!(ocg instanceof PDFDict)) continue;
    const raw = ocgs.get(i);
    let hidden = raw instanceof PDFRef && off.has(String(raw.objectNumber));
    const usage = ocg.lookup(PDFName.of("Usage"));
    if (usage instanceof PDFDict) {
      const view = usage.lookup(PDFName.of("View"));
      if (view instanceof PDFDict && nameOf(view.lookup(PDFName.of("ViewState"))) === "OFF") hidden = true;
    }
    const layer = textOf(ocg.lookup(PDFName.of("Name"))) || "Untitled layer";
    findings.push(finding({
      kind: "layer",
      severity: hidden ? "high" : "low",
      title: hidden ? "A hidden layer is in this file" : "A layer is in this file",
      detail: truncate(layer),
      why: hidden
        ? "A hidden layer can hold text that does not show until someone turns the layer on."
        : "The text on a layer stays in the file when the layer is switched off.",
    }));
  }
}

export function annotSubtype(dict: PDFDict): string {
  return nameOf(dict.lookup(PDFName.of("Subtype")));
}

export function forEachAnnot(page: PDFPage, visit: (dict: PDFDict, index: number) => void) {
  const annots = page.node.Annots();
  if (!annots) return;
  for (let i = 0; i < annots.size(); i++) {
    const dict = annots.lookup(i);
    if (dict instanceof PDFDict) visit(dict, i);
  }
}
