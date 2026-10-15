import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { cleanPdf, DEFAULT_TOGGLES, type CleanToggles } from "./lib/clean";
import { cleanSummary, type Finding, type Severity } from "./lib/findings";
import { scanDocument, type ScanReport } from "./lib/scan";
import { zipStore } from "./lib/zip";
import { openPdf } from "./pdfjs";
import { rasterizePage, renderThumbnail, type Thumbnail } from "./raster";

interface Checked {
  id: string;
  name: string;
  bytes: Uint8Array;
  report: ScanReport | null;
  thumbs: Thumbnail[];
  error?: string;
  summary?: string;
}

type Phase =
  | { status: "empty" }
  | { status: "busy"; message: string }
  | { status: "error"; message: string }
  | { status: "files"; files: Checked[]; active: number | null; cleaning: boolean; note?: string };

const GROUPS: { severity: Severity; label: string }[] = [
  { severity: "high", label: "High" },
  { severity: "medium", label: "Medium" },
  { severity: "low", label: "Low" },
];

const TOGGLE_COPY: { key: keyof CleanToggles; label: string }[] = [
  { key: "burnRedactions", label: "Burn black boxes into the page" },
  { key: "stripMetadata", label: "Remove author and other file info" },
  { key: "removeAttachments", label: "Remove attached files" },
  { key: "removeScripts", label: "Remove scripts" },
  { key: "removeAnnotations", label: "Remove comments and highlights" },
  { key: "flattenForms", label: "Clear form answers" },
];

function readError(err: unknown) {
  const name = err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
  if (name === "PasswordException") return "This PDF is encrypted. Remove the password and try again.";
  if (name === "InvalidPDFException") return "This file is not a PDF.";
  return "Could not read this PDF.";
}

function cleanedName(name: string) {
  return `${name.replace(/\.pdf$/i, "")}.cleaned.pdf`;
}

function earlierName(name: string, index: number, total: number) {
  const stem = name.replace(/\.pdf$/i, "");
  return total > 1 ? `${stem}.earlier-${index + 1}.pdf` : `${stem}.earlier.pdf`;
}

function saveBytes(bytes: Uint8Array, filename: string, type: string) {
  const copy = new Uint8Array(bytes);
  const url = URL.createObjectURL(new Blob([copy], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  return url;
}

function rectsByPage(report: ScanReport) {
  const pages = new Map<number, NonNullable<Finding["rect"]>[]>();
  for (const item of report.findings) {
    if (!item.page || !item.rect) continue;
    const list = pages.get(item.page) ?? [];
    list.push(item.rect);
    pages.set(item.page, list);
  }
  return pages;
}

export default function App() {
  const [phase, setPhase] = useState<Phase>({ status: "empty" });
  const [toggles, setToggles] = useState<CleanToggles>(DEFAULT_TOGGLES);
  const [hot, setHot] = useState(false);
  const seq = useRef(0);
  const docs = useRef(new Map<string, PDFDocumentProxy>());
  const urls = useRef<string[]>([]);
  const dragDepth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const releaseUrls = () => {
    for (const url of urls.current) URL.revokeObjectURL(url);
    urls.current.length = 0;
  };

  const destroyDocs = async () => {
    const pending = [...docs.current.values()].map((doc) => doc.destroy().catch(() => undefined));
    docs.current.clear();
    await Promise.all(pending);
  };

  useEffect(() => {
    const liveDocs = docs.current;
    const liveUrls = urls.current;
    const stop = (event: Event) => event.preventDefault();
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
      for (const url of liveUrls) URL.revokeObjectURL(url);
      for (const doc of liveDocs.values()) void doc.destroy().catch(() => undefined);
    };
  }, []);

  const remember = (url: string) => {
    urls.current.push(url);
    return url;
  };

  const inspect = async (bytes: Uint8Array, name: string): Promise<Checked> => {
    const id = crypto.randomUUID();
    const doc = await openPdf(bytes);
    docs.current.set(id, doc);
    try {
      const report = await scanDocument(bytes, doc);
      const thumbs: Thumbnail[] = [];
      for (const [page, rects] of rectsByPage(report)) {
        const thumb = await renderThumbnail(doc, page, rects);
        if (thumb) {
          remember(thumb.url);
          thumbs.push(thumb);
        }
      }
      return { id, name, bytes, report, thumbs };
    } catch (err) {
      docs.current.delete(id);
      await doc.destroy().catch(() => undefined);
      throw err;
    }
  };

  const openList = async (list: File[]) => {
    if (!list.length) return;
    const id = ++seq.current;
    setPhase({
      status: "busy",
      message: list.length > 1 ? "Reading the files. This stays on your computer." : "Reading the file. This stays on your computer.",
    });
    setHot(false);
    releaseUrls();
    await destroyDocs();
    if (id !== seq.current) return;
    const files: Checked[] = [];
    for (const file of list) {
      if (id !== seq.current) return;
      const name = file.name || "document.pdf";
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (id !== seq.current) return;
        files.push(await inspect(bytes, name));
      } catch (err) {
        files.push({
          id: crypto.randomUUID(),
          name,
          bytes: new Uint8Array(),
          report: null,
          thumbs: [],
          error: readError(err),
        });
      }
    }
    if (id !== seq.current) return;
    if (files.length === 1 && files[0]?.error) {
      setPhase({ status: "error", message: files[0].error });
      return;
    }
    setPhase({ status: "files", files, active: files.length === 1 ? 0 : null, cleaning: false });
  };

  const loadSample = async () => {
    const id = ++seq.current;
    setPhase({ status: "busy", message: "Reading the file. This stays on your computer." });
    releaseUrls();
    await destroyDocs();
    if (id !== seq.current) return;
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}samples/privacy-check.pdf`);
      if (!res.ok) throw new Error("sample");
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (id !== seq.current) return;
      const file = await inspect(bytes, "privacy-check.pdf");
      if (id !== seq.current) return;
      setPhase({ status: "files", files: [file], active: 0, cleaning: false });
    } catch (err) {
      if (id !== seq.current) return;
      const failedFetch = err instanceof Error && err.message === "sample";
      setPhase({ status: "error", message: failedFetch ? "Could not load the sample." : readError(err) });
    }
  };

  const replaceFile = (files: Checked[], index: number, next: Checked) => files.map((file, i) => (i === index ? next : file));

  const cleanAt = async (files: Checked[], index: number) => {
    const file = files[index];
    if (!file?.report) return file;
    const doc = docs.current.get(file.id);
    if (!doc) return file;
    const before = file.report.score;
    const cleaned = await cleanPdf({
      source: file.bytes,
      report: file.report.audit,
      rasterize: (request) => rasterizePage(doc, request),
      toggles,
    });
    await doc.destroy().catch(() => undefined);
    docs.current.delete(file.id);
    for (const thumb of file.thumbs) URL.revokeObjectURL(thumb.url);
    const nextDoc = await openPdf(cleaned);
    docs.current.set(file.id, nextDoc);
    const report = await scanDocument(cleaned, nextDoc);
    const thumbs: Thumbnail[] = [];
    for (const [page, rects] of rectsByPage(report)) {
      const thumb = await renderThumbnail(nextDoc, page, rects);
      if (thumb) {
        remember(thumb.url);
        thumbs.push(thumb);
      }
    }
    return {
      ...file,
      bytes: cleaned,
      report,
      thumbs,
      summary: cleanSummary(before, report.score),
      error: undefined,
    };
  };

  const cleanActive = async () => {
    if (phase.status !== "files" || phase.active === null || phase.cleaning) return;
    const index = phase.active;
    const id = seq.current;
    setPhase({ ...phase, cleaning: true, note: "Building a cleaner copy. This stays on your computer." });
    try {
      const next = await cleanAt(phase.files, index);
      if (!next || id !== seq.current) return;
      const bytes = next.bytes;
      const url = saveBytes(bytes, cleanedName(next.name), "application/pdf");
      remember(url);
      if (id !== seq.current) return;
      setPhase({
        status: "files",
        files: replaceFile(phase.files, index, next),
        active: index,
        cleaning: false,
      });
    } catch {
      if (id !== seq.current) return;
      setPhase({ ...phase, cleaning: false, note: "Could not build the cleaned PDF." });
    }
  };

  const cleanAll = async () => {
    if (phase.status !== "files" || phase.cleaning) return;
    const id = seq.current;
    const start = phase.files;
    setPhase({ ...phase, cleaning: true, note: "Building cleaner copies. This stays on your computer." });
    const nextFiles = [...start];
    const packed: { name: string; bytes: Uint8Array }[] = [];
    try {
      for (let index = 0; index < start.length; index++) {
        if (id !== seq.current) return;
        if (!start[index]?.report) continue;
        const next = await cleanAt(nextFiles, index);
        if (!next || id !== seq.current) return;
        nextFiles[index] = next;
        packed.push({ name: cleanedName(next.name), bytes: next.bytes });
      }
      if (!packed.length) throw new Error("empty");
      const zip = zipStore(packed);
      const url = saveBytes(zip, "cleaned-pdfs.zip", "application/zip");
      remember(url);
      if (id !== seq.current) return;
      setPhase({ status: "files", files: nextFiles, active: phase.active, cleaning: false, note: "Cleaned copies are in the download." });
    } catch {
      if (id !== seq.current) return;
      setPhase({ status: "files", files: nextFiles, active: phase.active, cleaning: false, note: "Could not build the cleaned PDF." });
    }
  };

  const files = phase.status === "files" ? phase.files : [];
  const active = phase.status === "files" && phase.active !== null ? phase.files[phase.active] : undefined;
  const showList = phase.status === "files" && files.length > 1 && phase.active === null;

  const onDrop = (event: ReactDragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    setHot(false);
    const dropped = [...event.dataTransfer.files];
    if (dropped.length) void openList(dropped);
  };

  return (
    <main className="wrap">
      <header>
        <p className="brand">PDF Privacy Check</p>
        {active?.report ? (
          <>
            <p className="score" aria-label={`Score ${active.report.score.letter}`}>{active.report.score.letter}</p>
            <h1 className="sentence">{active.summary ?? active.report.score.sentence}</h1>
            <p className="file-name">{active.name}</p>
          </>
        ) : (
          <>
            <h1>Find what your PDF is secretly leaking.</h1>
            <p className="lede">Black boxes, hidden text, and old saves can still be in the file. This check reads it here and can hand you a cleaner copy.</p>
          </>
        )}
      </header>

      <input
        ref={inputRef}
        id="pdf-file"
        className="file"
        type="file"
        accept="application/pdf,.pdf"
        multiple
        onChange={(event) => {
          const chosen = [...(event.target.files ?? [])];
          event.target.value = "";
          if (chosen.length) void openList(chosen);
        }}
      />

      <label
        htmlFor="pdf-file"
        className={hot ? `drop hot${files.length ? " compact" : ""}` : `drop${files.length ? " compact" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          dragDepth.current += 1;
          setHot(true);
        }}
        onDragLeave={() => {
          dragDepth.current -= 1;
          if (dragDepth.current <= 0) {
            dragDepth.current = 0;
            setHot(false);
          }
        }}
        onDrop={onDrop}
      >
        <span className="drop-title">{files.length ? "Drop another PDF" : "Drop a PDF"}</span>
        <span className="drop-hint">or choose files</span>
      </label>

      <div className="links">
        <button type="button" className="link" onClick={() => void loadSample()}>Try a sample</button>
        {files.length > 1 && phase.status === "files" && phase.active !== null && (
          <button type="button" className="link" onClick={() => setPhase({ ...phase, active: null, note: undefined })}>All files</button>
        )}
      </div>

      {phase.status === "busy" && <p className="status" role="status">{phase.message}</p>}
      {phase.status === "error" && <p className="status error" role="alert">{phase.message}</p>}
      {phase.status === "files" && phase.note && <p className="status" role="status">{phase.note}</p>}

      {showList && phase.status === "files" && (
        <section>
          <ul className="batch">
            {files.map((file, index) => (
              <li key={file.id}>
                <button type="button" onClick={() => setPhase({ ...phase, active: index })}>
                  <span className="name">{file.name}</span>
                  <span className="grade">{file.report?.score.letter ?? "–"}</span>
                </button>
                <p>{file.error ?? file.summary ?? file.report?.score.sentence}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {active?.error && <p className="status error" role="alert">{active.error}</p>}

      {active?.report && (
        <section aria-live="polite">
          {active.thumbs.length > 0 && (
            <div className="pages">
              {active.thumbs.map((thumb) => (
                <article key={thumb.page}>
                  <h2 className="page-label">Page {thumb.page}</h2>
                  <div className="thumb">
                    <img src={thumb.url} alt="" width={thumb.width} height={thumb.height} />
                    <svg viewBox={`0 0 ${thumb.width} ${thumb.height}`} aria-hidden="true">
                      {thumb.outlines.map((points, index) => (
                        <polygon key={index} points={points} />
                      ))}
                    </svg>
                  </div>
                </article>
              ))}
            </div>
          )}
          <div className="groups">
            {GROUPS.map((group) => {
              const items = active.report!.findings.filter((item) => item.severity === group.severity);
              if (!items.length) return null;
              return (
                <section key={group.severity}>
                  <h2>{group.label}</h2>
                  <ul className="cards">
                    {items.map((item) => (
                      <li key={item.id}>
                        <h3>{item.title}</h3>
                        <p className="why">{item.why}</p>
                        {item.page && <p className="where">Page {item.page}</p>}
                        <details>
                          <summary>Details</summary>
                          <p className="mono">{item.detail}</p>
                        </details>
                        {item.kind === "revision" && active.report!.revisions.map((revision, index) => (
                          <button
                            key={revision.label}
                            type="button"
                            className="link"
                            onClick={() => remember(saveBytes(revision.bytes, earlierName(active.name, index, active.report!.revisions.length), "application/pdf"))}
                          >
                            Download earlier version
                          </button>
                        ))}
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </section>
      )}

      {active?.report && (
        <div className="actions">
          <fieldset className="toggles">
            <legend>What to remove</legend>
            {TOGGLE_COPY.map((toggle) => (
              <label key={toggle.key}>
                <input
                  type="checkbox"
                  checked={toggles[toggle.key]}
                  onChange={(event) => setToggles({ ...toggles, [toggle.key]: event.target.checked })}
                />
                <span>{toggle.label}</span>
              </label>
            ))}
          </fieldset>
          <button type="button" className="primary" onClick={() => void cleanActive()} disabled={phase.status === "files" && phase.cleaning}>
            {phase.status === "files" && phase.cleaning ? "Cleaning…" : "Clean & download"}
          </button>
        </div>
      )}

      {showList && (
        <div className="actions">
          <fieldset className="toggles">
            <legend>What to remove</legend>
            {TOGGLE_COPY.map((toggle) => (
              <label key={toggle.key}>
                <input
                  type="checkbox"
                  checked={toggles[toggle.key]}
                  onChange={(event) => setToggles({ ...toggles, [toggle.key]: event.target.checked })}
                />
                <span>{toggle.label}</span>
              </label>
            ))}
          </fieldset>
          <button type="button" className="primary" onClick={() => void cleanAll()} disabled={phase.status === "files" && phase.cleaning}>
            {phase.status === "files" && phase.cleaning ? "Cleaning…" : "Clean & download all"}
          </button>
        </div>
      )}

      <footer>Your files never leave this tab.</footer>
    </main>
  );
}
