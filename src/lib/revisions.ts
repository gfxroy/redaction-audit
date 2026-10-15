function latin1(bytes: Uint8Array): string {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return out;
}

function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 255;
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export interface RevisionMark {
  /** Byte offset of the previous xref, from the startxref line. */
  prev: number;
  /** Exclusive end of this revision, just after %%EOF and one trailing newline. */
  end: number;
}

const MARK = /startxref\s+(\d+)\s+%%EOF/g;

/** Every startxref/%%EOF pair. A file saved more than once has more than one. */
export function revisionMarks(bytes: Uint8Array): RevisionMark[] {
  const text = latin1(bytes);
  const marks: RevisionMark[] = [];
  for (const match of text.matchAll(MARK)) {
    let end = (match.index ?? 0) + match[0].length;
    if (text[end] === "\r") end += 1;
    if (text[end] === "\n") end += 1;
    marks.push({ prev: Number(match[1]), end });
  }
  return marks;
}

/** Bytes of each earlier save, oldest first. Empty when the file was saved once. */
export function earlierRevisions(bytes: Uint8Array): Uint8Array[] {
  const marks = revisionMarks(bytes);
  if (marks.length < 2) return [];
  return marks.slice(0, -1).map((mark) => bytes.slice(0, mark.end));
}

/**
 * Append a second trailer that points at the same xref.
 * The bytes up to the first %%EOF stay a valid PDF, which is the earlier save.
 */
export function appendRevision(bytes: Uint8Array): Uint8Array {
  const marks = revisionMarks(bytes);
  if (!marks.length) throw new Error("This is not a PDF.");
  const prev = marks[marks.length - 1].prev;
  return concat(bytes, latin1Bytes(`\nstartxref\n${prev}\n%%EOF\n`));
}
