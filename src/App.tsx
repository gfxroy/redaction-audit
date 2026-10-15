import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { auditDocument } from "./lib/audit";
import { fixPdf } from "./lib/fix";
import type { AuditReport, CoverKind, Leak } from "./lib/types";
import { openPdf } from "./pdfjs";
import { rasterizePage, renderThumbnail, type Thumbnail } from "./raster";

type Phase =
  | { status: "empty" }
  | { status: "busy"; message: string }
  | { status: "error"; message: string }
  | { status: "ready"; name: string; report: AuditReport; thumbs: Thumbnail[] }
  | { status: "fixing"; name: string; report: AuditReport; thumbs: Thumbnail[] }
  | { status: "fixed"; name: string; report: AuditReport; thumbs: Thumbnail[]; verified: boolean; url: string; downloadName: string };

function headline(count: number) {
  if (count === 0) return "No leaks found";
  if (count === 1) return "1 redaction leaks text";
  return `${count} redactions leak text`;
}

function kindLabel(kind: CoverKind) {
  if (kind === "white") return "White box";
  if (kind === "annotation") return "Annotation";
  return "Black box";
}

function readError(err: unknown) {
  const name = err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
  if (name === "PasswordException") return "This PDF is encrypted. Remove the password and try again.";
  if (name === "InvalidPDFException") return "This file is not a PDF.";
  return "Could not read this PDF.";
}

function fixedName(name: string) {
  return `${name.replace(/\.pdf$/i, "")}.fixed.pdf`;
}

function leaksOn(report: AuditReport, page: number): Leak[] {
  return report.leaks.filter((leak) => leak.page === page);
}

export default function App() {
  const [phase, setPhase] = useState<Phase>({ status: "empty" });
  const [hot, setHot] = useState(false);
  const seq = useRef(0);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const bytesRef = useRef<Uint8Array | null>(null);
  const urlsRef = useRef<string[]>([]);
  const dragDepth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const releaseUrls = () => {
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current = [];
  };

  useEffect(() => {
    const stop = (event: DragEvent) => event.preventDefault();
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
      void docRef.current?.destroy();
      for (const url of urlsRef.current) URL.revokeObjectURL(url);
    };
  }, []);

  const openBytes = async (bytes: Uint8Array, name: string, id = ++seq.current) => {
    setPhase({ status: "busy", message: "Reading the PDF." });
    setHot(false);
    await docRef.current?.destroy().catch(() => undefined);
    if (id !== seq.current) return;
    docRef.current = null;
    bytesRef.current = null;
    releaseUrls();
    try {
      const doc = await openPdf(bytes);
      if (id !== seq.current) {
        await doc.destroy();
        return;
      }
      const report = await auditDocument(doc);
      if (id !== seq.current) {
        await doc.destroy();
        return;
      }
      const thumbs: Thumbnail[] = [];
      for (const page of report.pages) {
        if (!page.leaks.length) continue;
        const thumb = await renderThumbnail(doc, page);
        if (id !== seq.current) {
          if (thumb) URL.revokeObjectURL(thumb.url);
          await doc.destroy();
          return;
        }
        if (thumb) thumbs.push(thumb);
      }
      docRef.current = doc;
      bytesRef.current = bytes;
      urlsRef.current = thumbs.map((thumb) => thumb.url);
      setPhase({ status: "ready", name, report, thumbs });
    } catch (err) {
      if (id !== seq.current) return;
      setPhase({ status: "error", message: readError(err) });
    }
  };

  const take = (file: File) => {
    void file.arrayBuffer().then((buf) => openBytes(new Uint8Array(buf), file.name || "document.pdf"));
  };

  const loadSample = async (which: "bad" | "clean") => {
    const name = which === "bad" ? "bad-redaction.pdf" : "clean-redaction.pdf";
    const id = ++seq.current;
    setPhase({ status: "busy", message: "Reading the PDF." });
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}samples/${name}`);
      if (!res.ok) throw new Error("sample");
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (id !== seq.current) return;
      await openBytes(bytes, name, id);
    } catch {
      if (id !== seq.current) return;
      setPhase({ status: "error", message: "Could not load the sample." });
    }
  };

  const fix = async () => {
    if (phase.status !== "ready" || !docRef.current || !bytesRef.current) return;
    const id = ++seq.current;
    const doc = docRef.current;
    const bytes = bytesRef.current;
    const { name, report, thumbs } = phase;
    setPhase({ status: "fixing", name, report, thumbs });
    try {
      const fixed = await fixPdf({
        source: bytes,
        report,
        rasterize: (request) => rasterizePage(doc, request),
      });
      await doc.destroy();
      if (docRef.current === doc) docRef.current = null;
      if (id !== seq.current) return;
      const check = await openPdf(fixed);
      let verified = false;
      try {
        const again = await auditDocument(check);
        verified = again.leakCount === 0;
      } finally {
        await check.destroy();
      }
      if (id !== seq.current) return;
      const url = URL.createObjectURL(new Blob([fixed.slice().buffer], { type: "application/pdf" }));
      urlsRef.current.push(url);
      setPhase({
        status: "fixed",
        name,
        report,
        thumbs,
        verified,
        url,
        downloadName: fixedName(name),
      });
    } catch {
      if (id !== seq.current) return;
      setPhase({ status: "error", message: "Could not build the fixed PDF." });
    }
  };

  const report = phase.status === "ready" || phase.status === "fixing" || phase.status === "fixed" ? phase.report : null;
  const thumbs = phase.status === "ready" || phase.status === "fixing" || phase.status === "fixed" ? phase.thumbs : [];
  const showDrop = !report;

  return (
    <main className="wrap">
      <header>
        <p className="brand">Redaction Audit</p>
        <h1>{report ? headline(report.leakCount) : "Drop a PDF."}</h1>
        <p className="lede">See if its black boxes actually hide anything — and fix them for real.</p>
      </header>

      <input
        ref={inputRef}
        id="pdf-file"
        className="file"
        type="file"
        accept="application/pdf,.pdf"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) take(file);
        }}
      />

      {showDrop && (
        <label
          htmlFor="pdf-file"
          className={hot ? "drop hot" : "drop"}
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
          onDrop={(event) => {
            event.preventDefault();
            dragDepth.current = 0;
            setHot(false);
            const file = event.dataTransfer.files[0];
            if (file) take(file);
          }}
        >
          <span className="drop-title">Drop a PDF</span>
          <span className="drop-hint">or choose a file</span>
        </label>
      )}

      <div className="links">
        <button type="button" className="link" onClick={() => void loadSample("bad")}>
          Try a sample
        </button>
        <button type="button" className="link" onClick={() => void loadSample("clean")}>
          Try a clean file
        </button>
        {report && (
          <button type="button" className="link" onClick={() => inputRef.current?.click()}>
            Choose another file
          </button>
        )}
      </div>

      {phase.status === "busy" && <p className="status">{phase.message}</p>}
      {phase.status === "error" && <p className="status">{phase.message}</p>}

      {report && (
        <section aria-live="polite">
          {(phase.status === "ready" || phase.status === "fixing" || phase.status === "fixed") && (
            <p className="file-name">{phase.name}</p>
          )}
          {report.leakCount === 0 && <p className="status">Nothing hidden under a box was recovered.</p>}
          <div className="pages">
            {report.pages.filter((page) => page.leaks.length > 0).map((page) => {
              const thumb = thumbs.find((item) => item.page === page.page);
              return (
                <article className="page" key={page.page}>
                  <h2>Page {page.page}</h2>
                  {thumb && (
                    <div className="thumb">
                      <img src={thumb.url} alt="" width={thumb.width} height={thumb.height} />
                      <svg viewBox={`0 0 ${thumb.width} ${thumb.height}`} aria-hidden="true">
                        {thumb.outlines.map((points, index) => (
                          <polygon key={index} points={points} />
                        ))}
                      </svg>
                    </div>
                  )}
                  <ul className="leaks">
                    {leaksOn(report, page.page).map((leak, index) => (
                      <li key={`${leak.kind}-${index}`}>
                        <code>{leak.text}</code>
                        <span className="kind">{kindLabel(leak.kind)}</span>
                      </li>
                    ))}
                  </ul>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {phase.status === "ready" && phase.report.leakCount > 0 && (
        <div className="actions">
          <button type="button" className="primary" onClick={() => void fix()}>
            Fix
          </button>
        </div>
      )}

      {phase.status === "fixing" && (
        <div className="actions">
          <button type="button" className="primary" disabled>
            Fixing…
          </button>
        </div>
      )}

      {phase.status === "fixed" && (
        <div className="actions">
          <p className="verified">
            {phase.verified ? "Verified. No leaked text remains." : "The fixed file still has leaked text."}
          </p>
          {phase.verified && (
            <a className="primary" href={phase.url} download={phase.downloadName}>
              Download {phase.downloadName}
            </a>
          )}
        </div>
      )}

      <footer>The file stays in this tab. Nothing is uploaded.</footer>
    </main>
  );
}
