export interface GpsFix {
  lat: number;
  lon: number;
  /** Human label, for example "37.7750 N, 122.4194 W". */
  label: string;
}

export interface ExifInfo {
  gps: GpsFix | null;
  date: string | null;
  camera: string | null;
}

function u16(view: DataView, offset: number, little: boolean): number {
  return view.getUint16(offset, little);
}
function u32(view: DataView, offset: number, little: boolean): number {
  return view.getUint32(offset, little);
}

function rational(view: DataView, offset: number, little: boolean): number {
  const n = u32(view, offset, little);
  const d = u32(view, offset + 4, little);
  return d ? n / d : 0;
}

interface Entry {
  tag: number;
  type: number;
  count: number;
  value: number;
}

function entries(view: DataView, offset: number, little: boolean): Entry[] {
  if (offset < 0 || offset + 2 > view.byteLength) return [];
  const count = u16(view, offset, little);
  const out: Entry[] = [];
  for (let i = 0; i < count; i++) {
    const at = offset + 2 + i * 12;
    if (at + 12 > view.byteLength) break;
    out.push({
      tag: u16(view, at, little),
      type: u16(view, at + 2, little),
      count: u32(view, at + 4, little),
      value: u32(view, at + 8, little),
    });
  }
  return out;
}

function ascii(view: DataView, entry: Entry): string {
  const bytes: number[] = [];
  const start = entry.count <= 4 ? 0 : entry.value;
  // The value field itself holds the bytes when they fit in 4 bytes. We only
  // need the offset form for camera and date strings, which are longer.
  const base = entry.count <= 4 ? -1 : start;
  if (base < 0) return "";
  for (let i = 0; i < entry.count; i++) {
    const b = view.getUint8(base + i);
    if (b === 0) break;
    bytes.push(b);
  }
  return String.fromCharCode(...bytes);
}

function gpsDegrees(view: DataView, entry: Entry, little: boolean): number {
  const base = entry.value;
  const deg = rational(view, base, little);
  const min = rational(view, base + 8, little);
  const sec = rational(view, base + 16, little);
  return deg + min / 60 + sec / 3600;
}

function parseTiff(tiff: Uint8Array): ExifInfo | null {
  if (tiff.length < 8) return null;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  const big = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!little && !big) return null;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  if (u16(view, 2, little) !== 42) return null;
  const ifd0 = entries(view, u32(view, 4, little), little);
  let date: string | null = null;
  let camera: string | null = null;
  let gpsOffset: number | null = null;
  for (const entry of ifd0) {
    if (entry.tag === 0x0132) date = ascii(view, entry);
    if (entry.tag === 0x010f) camera = ascii(view, entry);
    if (entry.tag === 0x8825) gpsOffset = entry.value;
  }
  let gps: GpsFix | null = null;
  if (gpsOffset !== null) {
    const gpsIfd = entries(view, gpsOffset, little);
    const byTag = new Map(gpsIfd.map((entry) => [entry.tag, entry]));
    const lat = byTag.get(2);
    const lon = byTag.get(4);
    const latRef = byTag.get(1);
    const lonRef = byTag.get(3);
    if (lat && lon) {
      let latDeg = gpsDegrees(view, lat, little);
      let lonDeg = gpsDegrees(view, lon, little);
      const latChar = latRef ? asciiRef(latRef, little) : "N";
      const lonChar = lonRef ? asciiRef(lonRef, little) : "E";
      if (latChar === "S") latDeg = -latDeg;
      if (lonChar === "W") lonDeg = -lonDeg;
      gps = {
        lat: latDeg,
        lon: lonDeg,
        label: `${Math.abs(latDeg).toFixed(4)} ${latChar}, ${Math.abs(lonDeg).toFixed(4)} ${lonChar}`,
      };
    }
  }
  if (!gps && !date && !camera) return null;
  return { gps, date, camera };
}

function asciiRef(entry: Entry, little: boolean): string {
  // A 2-byte ASCII ref fits in the value field.
  const bytes = little ? [entry.value & 255, (entry.value >> 8) & 255] : [(entry.value >> 24) & 255, (entry.value >> 16) & 255];
  return String.fromCharCode(...bytes.filter((b) => b !== 0));
}

/** Read Exif APP1 segments from a JPEG, including one embedded in a PDF stream. */
export function readExif(bytes: Uint8Array): ExifInfo | null {
  for (let i = 0; i + 4 < bytes.length; i++) {
    if (bytes[i] !== 0xff || bytes[i + 1] !== 0xe1) continue;
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    const start = i + 4;
    const end = Math.min(bytes.length, start + length - 2);
    if (end - start < 6) continue;
    if (String.fromCharCode(...bytes.subarray(start, start + 6)) !== "Exif\0\0") continue;
    const info = parseTiff(bytes.subarray(start + 6, end));
    if (info) return info;
  }
  return null;
}

function pushU16(out: number[], value: number) {
  out.push(value & 255, (value >> 8) & 255);
}
function pushU32(out: number[], value: number) {
  out.push(value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >> 24) & 255);
}

function rationalBytes(value: number): number[] {
  let whole = Math.floor(value);
  const minutesFloat = (value - whole) * 60;
  let minutes = Math.floor(minutesFloat);
  let seconds = Math.round((minutesFloat - minutes) * 60 * 100);
  if (seconds >= 6000) {
    seconds = 0;
    minutes += 1;
  }
  if (minutes >= 60) {
    minutes = 0;
    whole += 1;
  }
  const out: number[] = [];
  for (const [n, d] of [[whole, 1], [minutes, 1], [seconds, 100]] as const) {
    pushU32(out, n);
    pushU32(out, d);
  }
  return out;
}

/** 1×1 JPEG that pdf-lib can embed. APP1 is inserted after the SOI marker. */
const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGf/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA//9k=";

function baseJpeg(): Uint8Array {
  const bin = atob(TINY_JPEG_B64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A 1×1 JPEG with a GPS Exif block inserted after the start-of-image marker. */
export function jpegWithGps(lat = 37.7749, lon = -122.4194): Uint8Array {
  const latAbs = Math.abs(lat);
  const lonAbs = Math.abs(lon);
  const latRats = rationalBytes(latAbs);
  const lonRats = rationalBytes(lonAbs);
  // TIFF layout, little-endian. Offsets are from the TIFF start.
  // Header 8 bytes. IFD0 at 8: 3 entries (Make skipped) DateTime, GPS pointer, plus next=0.
  // We'll write: IFD0 with GPS tag only, GPS IFD, then the rational payloads.
  const tiff: number[] = [];
  tiff.push(0x49, 0x49, 42, 0);
  pushU32(tiff, 8);
  // IFD0: one entry, GPS IFD pointer. Next IFD 0.
  pushU16(tiff, 1);
  pushU16(tiff, 0x8825);
  pushU16(tiff, 4); // LONG
  pushU32(tiff, 1);
  const gpsOffsetSlot = tiff.length;
  pushU32(tiff, 0); // filled once we know the GPS IFD offset
  pushU32(tiff, 0); // next IFD
  const gpsAt = tiff.length;
  tiff[gpsOffsetSlot] = gpsAt & 255;
  tiff[gpsOffsetSlot + 1] = (gpsAt >> 8) & 255;
  tiff[gpsOffsetSlot + 2] = (gpsAt >> 16) & 255;
  tiff[gpsOffsetSlot + 3] = (gpsAt >> 24) & 255;
  // GPS IFD: lat ref, lat, lon ref, lon.
  pushU16(tiff, 4);
  const refs: { tag: number; char: string }[] = [
    { tag: 1, char: lat >= 0 ? "N" : "S" },
    { tag: 3, char: lon >= 0 ? "E" : "W" },
  ];
  // Interleave in tag order: 1, 2, 3, 4.
  const writeRef = (tag: number, char: string) => {
    pushU16(tiff, tag);
    pushU16(tiff, 2); // ASCII
    pushU32(tiff, 2);
    tiff.push(char.charCodeAt(0), 0, 0, 0);
  };
  const writeRats = (tag: number) => {
    pushU16(tiff, tag);
    pushU16(tiff, 5); // RATIONAL
    pushU32(tiff, 3);
    const slot = tiff.length;
    pushU32(tiff, 0);
    return slot;
  };
  writeRef(refs[0].tag, refs[0].char);
  const latSlot = writeRats(2);
  writeRef(refs[1].tag, refs[1].char);
  const lonSlot = writeRats(4);
  pushU32(tiff, 0);
  const latAt = tiff.length;
  tiff.push(...latRats);
  const lonAt = tiff.length;
  tiff.push(...lonRats);
  const put = (slot: number, value: number) => {
    tiff[slot] = value & 255;
    tiff[slot + 1] = (value >> 8) & 255;
    tiff[slot + 2] = (value >> 16) & 255;
    tiff[slot + 3] = (value >> 24) & 255;
  };
  put(latSlot, latAt);
  put(lonSlot, lonAt);

  const exifHeader = [0x45, 0x78, 0x69, 0x66, 0, 0];
  const payload = [...exifHeader, ...tiff];
  const length = payload.length + 2;
  const app1 = Uint8Array.from([0xff, 0xe1, (length >> 8) & 255, length & 255, ...payload]);
  const base = baseJpeg();
  const out = new Uint8Array(base.length + app1.length);
  out[0] = 0xff;
  out[1] = 0xd8;
  out.set(app1, 2);
  out.set(base.subarray(2), 2 + app1.length);
  return out;
}
