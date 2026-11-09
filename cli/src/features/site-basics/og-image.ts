/*
 * cli/src/features/site-basics/og-image.ts — the default social card.
 *
 * A link shared without an `og:image` renders as a bare line of text in most
 * chats and feeds, and `twitter:card = summary_large_image` with no image
 * falls back to the small card. So every project gets a 1200×630 PNG at
 * `public/og.png` from the start: the project's own app icon, centred on its
 * manifest background colour. It is a placeholder that is honest about what
 * the thing is, not a designed card — the docs say to replace it.
 *
 * Pure Node (zlib only): the CLI has no image library, and adding a native
 * one to draw a single rectangle is not a trade worth making. The decoder
 * reads exactly what icon sources are — 8-bit RGB or RGBA, not interlaced —
 * and answers `null` for anything else, which leaves a plain card rather
 * than a wrong one. The output is deterministic, so a test can pin it.
 */

import { deflateSync, inflateSync } from "node:zlib";

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;
/** Icon edge on the card, in pixels. */
const ICON_SIZE = 300;
/** Corner radius as a share of the icon edge, close to a launcher mask. */
const CORNER_RATIO = 0.2237;

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface RgbaImage {
  width: number;
  height: number;
  /** width × height × 4 bytes, straight (not premultiplied) alpha. */
  data: Uint8Array;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode an 8-bit RGB or RGBA, non-interlaced PNG. `null` for anything
 *  else, and for anything that is not a well-formed PNG. */
export function decodePng(bytes: Uint8Array): RgbaImage | null {
  const buf = Buffer.from(bytes);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  try {
    while (offset + 8 <= buf.length) {
      const length = buf.readUInt32BE(offset);
      const type = buf.toString("latin1", offset + 4, offset + 8);
      const body = buf.subarray(offset + 8, offset + 8 + length);
      offset += 12 + length;
      if (type === "IHDR") {
        width = body.readUInt32BE(0);
        height = body.readUInt32BE(4);
        const [depth, colorType, , , interlace] = body.subarray(8, 13);
        if (depth !== 8 || interlace !== 0) return null;
        if (colorType === 6) channels = 4;
        else if (colorType === 2) channels = 3;
        else return null;
      } else if (type === "IDAT") {
        idat.push(body);
      } else if (type === "IEND") {
        break;
      }
    }
    if (!width || !height || !channels || width * height > 4096 * 4096) return null;
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    if (raw.length < (stride + 1) * height) return null;
    const pixels = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)];
      const src = y * (stride + 1) + 1;
      const row = y * stride;
      for (let x = 0; x < stride; x++) {
        const value = raw[src + x];
        const left = x >= channels ? pixels[row + x - channels] : 0;
        const up = y > 0 ? pixels[row - stride + x] : 0;
        const upLeft = y > 0 && x >= channels ? pixels[row - stride + x - channels] : 0;
        let out: number;
        if (filter === 0) out = value;
        else if (filter === 1) out = value + left;
        else if (filter === 2) out = value + up;
        else if (filter === 3) out = value + ((left + up) >> 1);
        else if (filter === 4) out = value + paeth(left, up, upLeft);
        else return null;
        pixels[row + x] = out & 0xff;
      }
    }
    if (channels === 4) return { width, height, data: pixels };
    const data = new Uint8Array(width * height * 4);
    for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
      data[j] = pixels[i];
      data[j + 1] = pixels[i + 1];
      data[j + 2] = pixels[i + 2];
      data[j + 3] = 255;
    }
    return { width, height, data };
  } catch {
    return null;
  }
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** Encode an opaque RGB image (width × height × 3 bytes). */
export function encodePngRgb(width: number, height: number, rgb: Uint8Array): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    // Filter 0 everywhere: a card that is mostly one colour compresses to
    // almost nothing without the adaptive filters, and the bytes stay
    // independent of any heuristic.
    raw[y * (stride + 1)] = 0;
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Box-filter `icon` down (or up) to size × size, premultiplied, and apply
 *  the rounded-corner mask. Returns premultiplied RGBA as floats 0–255. */
function scaledIcon(icon: RgbaImage, size: number): Float32Array {
  const out = new Float32Array(size * size * 4);
  const radius = size * CORNER_RATIO;
  for (let ty = 0; ty < size; ty++) {
    const y0 = Math.floor((ty * icon.height) / size);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * icon.height) / size));
    for (let tx = 0; tx < size; tx++) {
      const x0 = Math.floor((tx * icon.width) / size);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * icon.width) / size));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * icon.width + x) * 4;
          const alpha = icon.data[i + 3] / 255;
          r += icon.data[i] * alpha;
          g += icon.data[i + 1] * alpha;
          b += icon.data[i + 2] * alpha;
          a += alpha;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      // Distance into the nearest corner circle, for an anti-aliased mask.
      const cx = Math.min(Math.max(tx + 0.5, radius), size - radius);
      const cy = Math.min(Math.max(ty + 0.5, radius), size - radius);
      const d = Math.hypot(tx + 0.5 - cx, ty + 0.5 - cy);
      const mask = Math.min(1, Math.max(0, radius - d + 0.5));
      const o = (ty * size + tx) * 4;
      out[o] = (r / n) * mask;
      out[o + 1] = (g / n) * mask;
      out[o + 2] = (b / n) * mask;
      out[o + 3] = (a / n) * mask;
    }
  }
  return out;
}

/** Parse "#rgb" or "#rrggbb"; `null` for anything else. */
export function parseHexColor(value: unknown): [number, number, number] | null {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** The card: `background`, with `icon` centred when there is one. */
export function renderSocialCard(args: {
  background: [number, number, number];
  icon?: RgbaImage | null;
}): Buffer {
  const rgb = new Uint8Array(CARD_WIDTH * CARD_HEIGHT * 3);
  const [br, bg, bb] = args.background;
  for (let i = 0; i < rgb.length; i += 3) {
    rgb[i] = br;
    rgb[i + 1] = bg;
    rgb[i + 2] = bb;
  }
  if (args.icon) {
    const icon = scaledIcon(args.icon, ICON_SIZE);
    const left = Math.floor((CARD_WIDTH - ICON_SIZE) / 2);
    const top = Math.floor((CARD_HEIGHT - ICON_SIZE) / 2);
    for (let y = 0; y < ICON_SIZE; y++) {
      for (let x = 0; x < ICON_SIZE; x++) {
        const s = (y * ICON_SIZE + x) * 4;
        const alpha = icon[s + 3];
        if (alpha === 0) continue;
        const d = ((top + y) * CARD_WIDTH + left + x) * 3;
        // Source-over with a premultiplied source.
        for (let c = 0; c < 3; c++) {
          const value = icon[s + c] + rgb[d + c] * (1 - alpha);
          rgb[d + c] = Math.min(255, Math.max(0, Math.round(value)));
        }
      }
    }
  }
  return encodePngRgb(CARD_WIDTH, CARD_HEIGHT, rgb);
}
