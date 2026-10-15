import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName } from "pdf-lib";
import { FIX_DPI, stripMetadata, type RasterizePage } from "./fix";
import {
  annotSubtype,
  collectAttachments,
  collectScripts,
  collectTextFields,
  deleteNameTree,
  nameOf,
  openActionScript,
  readInfo,
  writeInfo,
} from "./structure";
import type { AuditReport } from "./types";

export interface CleanToggles {
  burnRedactions: boolean;
  stripMetadata: boolean;
  removeAttachments: boolean;
  removeScripts: boolean;
  removeAnnotations: boolean;
  flattenForms: boolean;
}

export const DEFAULT_TOGGLES: CleanToggles = {
  burnRedactions: true,
  stripMetadata: true,
  removeAttachments: true,
  removeScripts: true,
  removeAnnotations: true,
  flattenForms: true,
};

function resolved(partial?: Partial<CleanToggles>): CleanToggles {
  return { ...DEFAULT_TOGGLES, ...partial };
}

function filterAnnots(doc: PDFDocument, keep: (dict: PDFDict) => boolean) {
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    const next = doc.context.obj([]);
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const dict = annots.lookup(i);
      if (raw && dict instanceof PDFDict && keep(dict)) next.push(raw);
    }
    if (next.size() === 0) page.node.delete(PDFName.of("Annots"));
    else page.node.set(PDFName.of("Annots"), next);
  }
}

function dropSignatureFields(doc: PDFDocument) {
  const acro = doc.catalog.lookup(PDFName.of("AcroForm"));
  if (!(acro instanceof PDFDict)) return;
  const fields = acro.lookup(PDFName.of("Fields"));
  if (!(fields instanceof PDFArray)) return;
  const next = doc.context.obj([]);
  for (let i = 0; i < fields.size(); i++) {
    const raw = fields.get(i);
    const field = fields.lookup(i);
    if (!raw) continue;
    if (field instanceof PDFDict && nameOf(field.lookup(PDFName.of("FT"))) === "Sig") continue;
    next.push(raw);
  }
  acro.set(PDFName.of("Fields"), next);
  filterAnnots(doc, (dict) => nameOf(dict.lookup(PDFName.of("FT"))) !== "Sig");
}

async function flattenOrDrop(doc: PDFDocument) {
  const acro = doc.catalog.lookup(PDFName.of("AcroForm"));
  if (!(acro instanceof PDFDict)) return;
  dropSignatureFields(doc);
  const fields = acro.lookup(PDFName.of("Fields"));
  if (!(fields instanceof PDFArray) || fields.size() === 0) {
    doc.catalog.delete(PDFName.of("AcroForm"));
    filterAnnots(doc, (dict) => annotSubtype(dict) !== "Widget");
    return;
  }
  try {
    const form = doc.getForm();
    if (form.getFields().length) form.flatten();
  } catch {
    doc.catalog.delete(PDFName.of("AcroForm"));
    filterAnnots(doc, (dict) => annotSubtype(dict) !== "Widget");
  }
}

function dropScripts(doc: PDFDocument) {
  deleteNameTree(doc, "JavaScript");
  doc.catalog.delete(PDFName.of("OpenAction"));
  doc.catalog.delete(PDFName.of("AA"));
  for (const page of doc.getPages()) {
    page.node.delete(PDFName.of("AA"));
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const dict = annots.lookup(i);
      if (!(dict instanceof PDFDict)) continue;
      const action = dict.lookup(PDFName.of("A"));
      if (action instanceof PDFDict && (nameOf(action.lookup(PDFName.of("S"))) === "JavaScript" || action.has(PDFName.of("JS")))) {
        dict.delete(PDFName.of("A"));
      }
      dict.delete(PDFName.of("AA"));
    }
  }
}

function dropAttachmentAnnots(doc: PDFDocument) {
  filterAnnots(doc, (dict) => annotSubtype(dict) !== "FileAttachment");
  deleteNameTree(doc, "EmbeddedFiles");
}

function uniqueName(name: string, used: Set<string>): string {
  const base = name.trim() || "item";
  let next = base;
  let n = 2;
  while (used.has(next)) {
    next = `${base}-${n}`;
    n += 1;
  }
  used.add(next);
  return next;
}

async function cleanInPlace(source: Uint8Array, toggles: CleanToggles): Promise<Uint8Array> {
  const doc = await PDFDocument.load(source, { updateMetadata: false });
  if (toggles.flattenForms) await flattenOrDrop(doc);
  if (toggles.removeAnnotations) {
    for (const page of doc.getPages()) page.node.delete(PDFName.of("Annots"));
  } else if (toggles.removeAttachments) dropAttachmentAnnots(doc);
  if (toggles.removeAttachments) deleteNameTree(doc, "EmbeddedFiles");
  if (toggles.removeScripts) dropScripts(doc);
  if (toggles.stripMetadata) stripMetadata(doc);
  return doc.save({ useObjectStreams: false, addDefaultPage: false });
}

async function cleanRebuild(
  source: Uint8Array,
  report: AuditReport,
  rasterize: RasterizePage,
  toggles: CleanToggles,
  dpi: number,
): Promise<Uint8Array> {
  const src = await PDFDocument.load(source, { updateMetadata: false });
  const info = toggles.stripMetadata ? undefined : readInfo(src);
  const files = toggles.removeAttachments ? [] : collectAttachments(src);
  const scripts = toggles.removeScripts ? [] : collectScripts(src);
  const openScript = toggles.removeScripts ? null : openActionScript(src);
  const fields = toggles.flattenForms ? [] : collectTextFields(src);
  const out = await PDFDocument.create({ updateMetadata: false });
  const byPage = new Map(report.pages.map((page) => [page.page, page]));

  for (let i = 0; i < src.getPageCount(); i++) {
    const pageNumber = i + 1;
    const audit = byPage.get(pageNumber);
    const srcPage = src.getPage(i);
    const size = srcPage.getSize();
    const width = audit?.width || size.width;
    const height = audit?.height || size.height;
    if (audit && audit.coverCount > 0) {
      const png = await rasterize({
        pageIndex: i,
        page: pageNumber,
        width,
        height,
        dpi,
        covers: audit.covers,
      });
      const image = await out.embedPng(png);
      const page = out.addPage([width, height]);
      page.drawImage(image, { x: 0, y: 0, width, height });
    } else {
      const [copied] = await out.copyPages(src, [i]);
      out.addPage(copied);
    }
  }

  if (toggles.removeAnnotations) {
    for (const page of out.getPages()) page.node.delete(PDFName.of("Annots"));
  } else if (toggles.removeAttachments) dropAttachmentAnnots(out);

  if (toggles.removeScripts) dropScripts(out);
  else {
    const used = new Set<string>();
    for (const script of scripts) out.addJavaScript(uniqueName(script.name, used), script.source);
    if (openScript) {
      const action = out.context.obj({
        Type: "Action",
        S: "JavaScript",
        JS: PDFHexString.fromText(openScript),
      });
      out.catalog.set(PDFName.of("OpenAction"), out.context.register(action));
    }
  }

  if (!toggles.removeAttachments) {
    const used = new Set<string>();
    for (const file of files) await out.attach(file.data, uniqueName(file.name, used));
  }

  if (!toggles.flattenForms && fields.length) {
    const form = out.getForm();
    const used = new Set<string>();
    for (const field of fields) {
      const text = form.createTextField(uniqueName(field.name, used));
      text.setText(field.value);
      const page = out.getPage(Math.min(field.pageIndex, out.getPageCount() - 1));
      text.addToPage(page, field.rect);
    }
  }

  if (info) writeInfo(out, info);
  if (toggles.stripMetadata) stripMetadata(out);
  return out.save({ useObjectStreams: false, addDefaultPage: false });
}

/**
 * Rebuild or edit the PDF according to the toggles.
 * Any path that saves a new file drops earlier incremental versions.
 * Burning a page replaces that page with a picture, which also removes hidden text on it.
 */
export async function cleanPdf(options: {
  source: Uint8Array;
  report: AuditReport;
  rasterize: RasterizePage;
  toggles?: Partial<CleanToggles>;
  dpi?: number;
}): Promise<Uint8Array> {
  const toggles = resolved(options.toggles);
  if (!Object.values(toggles).some(Boolean)) return options.source.slice();
  if (!toggles.burnRedactions) return cleanInPlace(options.source, toggles);
  return cleanRebuild(options.source, options.report, options.rasterize, toggles, options.dpi ?? FIX_DPI);
}
