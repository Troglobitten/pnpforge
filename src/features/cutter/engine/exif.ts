/**
 * Just enough EXIF/container sniffing for photo import: orientation, the time
 * the photo was taken, and whether the file is HEIC/HEIF (which most non-Apple
 * browsers can't decode).
 */
export interface PhotoMeta {
  orientation: number;
  /** ms since epoch, from DateTimeOriginal (local time as UTC), or null. */
  takenAt: number | null;
  format: 'jpeg' | 'png' | 'webp' | 'heic' | 'avif' | 'gif' | 'unknown';
}

export async function readMeta(file: Blob): Promise<PhotoMeta> {
  const buf = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  const format = sniff(buf);
  const out: PhotoMeta = { orientation: 1, takenAt: null, format };
  if (format !== 'jpeg') return out;
  try {
    let i = 2;
    while (i + 4 < buf.length) {
      if (buf[i] !== 0xff) break;
      const marker = buf[i + 1];
      const len = (buf[i + 2] << 8) | buf[i + 3];
      if (marker === 0xda) break; // start of scan
      if (marker === 0xe1 && buf[i + 4] === 0x45 && buf[i + 5] === 0x78 && buf[i + 6] === 0x69 && buf[i + 7] === 0x66) {
        parseTiff(buf, i + 10, out);
        break;
      }
      i += 2 + len;
    }
  } catch {
    /* ignore broken EXIF */
  }
  return out;
}

function sniff(b: Uint8Array): PhotoMeta['format'] {
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  const s = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP') return 'webp';
  if (s(0, 3) === 'GIF') return 'gif';
  if (s(4, 4) === 'ftyp') {
    const brands = s(8, 24);
    if (/avif|avis/.test(brands)) return 'avif';
    if (/heic|heix|hevc|heim|heis|mif1|msf1/.test(brands)) return 'heic';
  }
  return 'unknown';
}

function parseTiff(b: Uint8Array, t: number, out: PhotoMeta) {
  const le = b[t] === 0x49;
  const u16 = (o: number) => (le ? b[t + o] | (b[t + o + 1] << 8) : (b[t + o] << 8) | b[t + o + 1]);
  const u32 = (o: number) => (le ? (b[t + o] | (b[t + o + 1] << 8) | (b[t + o + 2] << 16) | (b[t + o + 3] << 24)) >>> 0 : ((b[t + o] << 24) | (b[t + o + 1] << 16) | (b[t + o + 2] << 8) | b[t + o + 3]) >>> 0);
  const readIfd = (off: number, cb: (tag: number, entry: number) => void) => {
    const n = u16(off);
    for (let k = 0; k < n && k < 200; k++) cb(u16(off + 2 + k * 12), off + 2 + k * 12);
  };
  let exifOff = 0;
  let dateTime: string | null = null;
  readIfd(u32(4), (tag, e) => {
    if (tag === 0x0112) out.orientation = u16(e + 8) || 1;
    if (tag === 0x8769) exifOff = u32(e + 8);
    if (tag === 0x0132) dateTime = str(b, t + u32(e + 8), 19);
  });
  if (exifOff)
    readIfd(exifOff, (tag, e) => {
      if (tag === 0x9003) dateTime = str(b, t + u32(e + 8), 19);
    });
  if (dateTime) {
    const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(dateTime);
    if (m) out.takenAt = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }
}

const str = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
