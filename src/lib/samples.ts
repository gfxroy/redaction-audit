import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts, degrees, rgb } from "pdf-lib";
import { jpegWithGps } from "./exif";
import { appendRevision } from "./revisions";

export const SECRETS = {
  visible: "Quarterly memo",
  ssn: "SSN 123-45-6789",
  account: "Account 9876543210",
  password: "hunter2",
  notALeak: "NOTALEAK",
  annot: "ANNOT-SECRET",
  highlight: "HIGHLIGHT-SECRET",
  redact: "REDACT-SECRET",
  tilted: "TILTED-COVER",
  rotated: "ROTATED-SECRET",
  page2: "Notes for the board.",
  clean: "Name on file",
} as const;

const FIXED_DATE = new Date(Date.UTC(2026, 0, 15));

function stamp(doc: PDFDocument) {
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
}

/** Text drawn first, black rectangles (and a whiteout, and annotations) drawn over it. */
export async function makeBadPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);

  const cover = (text: string, x: number, y: number, size: number, color: ReturnType<typeof rgb>) => {
    const w = font.widthOfTextAtSize(text, size);
    page.drawText(text, { x, y, size, font, color: rgb(0, 0, 0) });
    page.drawRectangle({ x: x - 3, y: y - 4, width: w + 6, height: size + 8, color });
  };

  page.drawText(SECRETS.visible, { x: 72, y: 740, size: 16, font, color: rgb(0, 0, 0) });
  cover(SECRETS.ssn, 72, 680, 16, rgb(0, 0, 0));
  cover(SECRETS.account, 72, 620, 14, rgb(0.05, 0.05, 0.05));

  const label = "Password: ";
  const labelW = font.widthOfTextAtSize(label, 14);
  const secretW = font.widthOfTextAtSize(SECRETS.password, 14);
  page.drawText(label, { x: 72, y: 560, size: 14, font, color: rgb(0, 0, 0) });
  page.drawText(SECRETS.password, { x: 72 + labelW, y: 560, size: 14, font, color: rgb(0, 0, 0) });
  page.drawRectangle({
    x: 72 + labelW,
    y: 556,
    width: secretW + 4,
    height: 22,
    color: rgb(1, 1, 1),
  });

  page.drawRectangle({ x: 72, y: 496, width: 120, height: 22, color: rgb(0, 0, 0) });
  page.drawText(SECRETS.notALeak, { x: 80, y: 500, size: 12, font, color: rgb(1, 1, 1) });

  const annotText = (text: string, x: number, y: number, size: number) => {
    const w = font.widthOfTextAtSize(text, size);
    page.drawText(text, { x, y, size, font, color: rgb(0, 0, 0) });
    return { x: x - 4, y: y - 4, x2: x + w + 8, y2: y + size + 6 };
  };
  const square = annotText(SECRETS.annot, 72, 440, 12);
  const highlight = annotText(SECRETS.highlight, 72, 390, 12);
  const redact = annotText(SECRETS.redact, 72, 340, 12);

  // Horizontal text under a rectangle that the page rotates 90 degrees.
  page.drawText(SECRETS.tilted, { x: 150, y: 80, size: 14, font, color: rgb(0, 0, 0) });
  page.drawRectangle({
    x: 340,
    y: 64,
    width: 36,
    height: 200,
    rotate: degrees(90),
    color: rgb(0, 0, 0),
  });

  const rotSize = 14;
  const rotW = font.widthOfTextAtSize(SECRETS.rotated, rotSize);
  page.drawText(SECRETS.rotated, { x: 470, y: 200, size: rotSize, font, color: rgb(0, 0, 0), rotate: degrees(90) });
  page.drawRectangle({
    x: 470 - rotSize - 6,
    y: 196,
    width: rotSize + 12,
    height: rotW + 10,
    color: rgb(0, 0, 0),
  });

  const ctx = doc.context;
  const squareAnnot = ctx.obj({
    Type: "Annot",
    Subtype: "Square",
    Rect: [square.x, square.y, square.x2, square.y2],
    IC: [0, 0, 0],
    C: [0, 0, 0],
    CA: 1,
    Border: [0, 0, 1],
  });
  const highlightAnnot = ctx.obj({
    Type: "Annot",
    Subtype: "Highlight",
    Rect: [highlight.x, highlight.y, highlight.x2, highlight.y2],
    QuadPoints: [highlight.x, highlight.y2, highlight.x2, highlight.y2, highlight.x, highlight.y, highlight.x2, highlight.y],
    C: [0, 0, 0],
  });
  const redactAnnot = ctx.obj({
    Type: "Annot",
    Subtype: "Redact",
    Rect: [redact.x, redact.y, redact.x2, redact.y2],
    IC: [0, 0, 0],
    QuadPoints: [redact.x, redact.y2, redact.x2, redact.y2, redact.x, redact.y, redact.x2, redact.y],
  });
  page.node.set(
    PDFName.of("Annots"),
    ctx.obj([ctx.register(squareAnnot), ctx.register(highlightAnnot), ctx.register(redactAnnot)]),
  );

  const page2 = doc.addPage([612, 792]);
  page2.drawText(SECRETS.page2, { x: 72, y: 700, size: 14, font, color: rgb(0, 0, 0) });

  doc.setTitle("Confidential memo");
  doc.setAuthor("Jane Doe");
  doc.setSubject("Internal");
  doc.setKeywords(["ssn", "account"]);
  doc.setProducer("Leaky Producer");
  doc.setCreator("Leaky Creator");
  stamp(doc);

  const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""><dc:title>Confidential memo</dc:title><dc:creator>Jane Doe</dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;
  const meta = doc.context.stream(xmp, { Type: "Metadata", Subtype: "XML" });
  doc.catalog.set(PDFName.of("Metadata"), doc.context.register(meta));

  return doc.save({ useObjectStreams: false });
}

/** A black bar with no text under it. */
export async function makeCleanPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText(SECRETS.clean, { x: 72, y: 700, size: 16, font, color: rgb(0, 0, 0) });
  page.drawRectangle({ x: 200, y: 696, width: 140, height: 22, color: rgb(0, 0, 0) });
  page.drawText("The value was removed before the box was drawn.", { x: 72, y: 660, size: 12, font, color: rgb(0, 0, 0) });
  doc.setTitle("Clean redaction");
  doc.setAuthor("Records");
  stamp(doc);
  return doc.save({ useObjectStreams: false });
}

/**
 * A sample that trips the privacy check: hidden text, a real redaction,
 * personal details, an attachment, a script, a signature, and an older save.
 */
export async function makePrivacyPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);

  page.drawText("Quarterly memo", { x: 72, y: 740, size: 16, font, color: rgb(0, 0, 0) });
  const secret = "SSN 123-45-6789";
  const secretW = font.widthOfTextAtSize(secret, 14);
  page.drawText(secret, { x: 72, y: 680, size: 14, font, color: rgb(0, 0, 0) });
  page.drawRectangle({ x: 69, y: 676, width: secretW + 8, height: 20, color: rgb(0, 0, 0) });

  page.drawText("ada@example.com", { x: 72, y: 640, size: 12, font, color: rgb(0, 0, 0) });
  page.drawText("4111 1111 1111 1111", { x: 72, y: 610, size: 12, font, color: rgb(0, 0, 0) });
  page.drawText("GB82 WEST 1234 5698 7654 32", { x: 72, y: 580, size: 12, font, color: rgb(0, 0, 0) });
  page.drawText("2345 6789 0123", { x: 72, y: 550, size: 12, font, color: rgb(0, 0, 0) });
  page.drawText("ABCDE1234F", { x: 72, y: 520, size: 12, font, color: rgb(0, 0, 0) });
  page.drawText("hidden white words", { x: 72, y: 480, size: 12, font, color: rgb(1, 1, 1) });
  page.drawText("tiny secret", { x: 72, y: 450, size: 1, font, color: rgb(0, 0, 0) });
  page.drawText("off the page", { x: 900, y: 80, size: 12, font, color: rgb(0, 0, 0) });

  const image = await doc.embedJpg(jpegWithGps());
  page.drawImage(image, { x: 430, y: 180, width: 36, height: 36 });

  const form = doc.getForm();
  const name = form.createTextField("Name");
  name.setText("Ada Lovelace");
  name.addToPage(page, { x: 72, y: 390, width: 180, height: 18 });

  const ctx = doc.context;
  const note = ctx.obj({
    Type: "Annot",
    Subtype: "Text",
    Rect: [300, 700, 322, 722],
    Contents: PDFString.of("Call (415) 555-2671"),
    Name: "Comment",
    F: 4,
  });
  const highlight = ctx.obj({
    Type: "Annot",
    Subtype: "Highlight",
    Rect: [72, 330, 210, 346],
    QuadPoints: [72, 346, 210, 346, 72, 330, 210, 330],
    Contents: PDFString.of("See the attachment"),
    C: [0.7, 0.7, 0.7],
  });
  const link = ctx.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [72, 300, 260, 318],
    Border: [0, 0, 0],
    A: { Type: "Action", S: "URI", URI: PDFString.of("https://example.com/track?id=ada") },
  });
  const csv = ctx.stream("item,amount\n", { Type: "EmbeddedFile", Subtype: "text/csv" });
  const csvRef = ctx.register(csv);
  const spec = ctx.obj({
    Type: "Filespec",
    F: PDFString.of("budget.csv"),
    EF: { F: csvRef },
  });
  const specRef = ctx.register(spec);
  const fileAnnot = ctx.obj({
    Type: "Annot",
    Subtype: "FileAttachment",
    Rect: [340, 700, 362, 722],
    FS: specRef,
    Contents: PDFString.of("budget.csv"),
    F: 4,
  });
  page.node.addAnnot(ctx.register(note));
  page.node.addAnnot(ctx.register(highlight));
  page.node.addAnnot(ctx.register(link));
  page.node.addAnnot(ctx.register(fileAnnot));

  const sig = ctx.obj({
    Type: "Sig",
    Filter: "Adobe.PPKLite",
    SubFilter: "adbe.pkcs7.detached",
    Name: PDFString.of("Ada Lovelace"),
    M: PDFString.of("D:20260115120000Z"),
    Reason: PDFString.of("Approval"),
    Contents: PDFHexString.of("00"),
    ByteRange: [0, 0, 0, 0],
  });
  const sigRef = ctx.register(sig);
  const widget = ctx.obj({
    Type: "Annot",
    Subtype: "Widget",
    FT: "Sig",
    T: PDFString.of("Signature"),
    V: sigRef,
    Rect: [380, 36, 560, 78],
    P: page.ref,
    F: 4,
  });
  const widgetRef = ctx.register(widget);
  const acro = doc.catalog.lookup(PDFName.of("AcroForm"));
  if (acro instanceof PDFDict) {
    const fields = acro.lookup(PDFName.of("Fields"));
    if (fields instanceof PDFArray) fields.push(widgetRef);
  }
  page.node.addAnnot(widgetRef);

  const page2 = doc.addPage([612, 792]);
  page2.drawText("Notes for the board.", { x: 72, y: 700, size: 14, font, color: rgb(0, 0, 0) });

  doc.setTitle("Confidential memo");
  doc.setAuthor("Ada Lovelace");
  doc.setSubject("Internal");
  doc.setKeywords(["payroll"]);
  doc.setCreator("Leaky Creator");
  doc.setProducer("Leaky Producer");
  stamp(doc);
  const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""><dc:title>Confidential memo</dc:title><dc:creator>Ada Lovelace</dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;
  const meta = ctx.stream(xmp, { Type: "Metadata", Subtype: "XML" });
  doc.catalog.set(PDFName.of("Metadata"), ctx.register(meta));

  await doc.attach(new TextEncoder().encode("payroll notes ada@example.com"), "notes.txt", { mimeType: "text/plain" });
  doc.addJavaScript("boot", 'var key = "AKIAIOSFODNN7EXAMPLE";');
  const open = ctx.obj({
    Type: "Action",
    S: "JavaScript",
    JS: PDFHexString.fromText("app.alert('opened');"),
  });
  doc.catalog.set(PDFName.of("OpenAction"), ctx.register(open));

  const ocg = ctx.obj({
    Type: "OCG",
    Name: PDFString.of("Hidden notes"),
    Usage: { View: { ViewState: "OFF" } },
  });
  const ocgRef = ctx.register(ocg);
  doc.catalog.set(PDFName.of("OCProperties"), ctx.obj({ OCGs: [ocgRef], D: { OFF: [ocgRef], Order: [ocgRef] } }));

  const saved = await doc.save({ useObjectStreams: false });
  return appendRevision(saved);
}
