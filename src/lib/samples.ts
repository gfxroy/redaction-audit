import { PDFDocument, PDFName, StandardFonts, degrees, rgb } from "pdf-lib";

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
