// Images: pictures attached to the board, referenced from Markdown (contract v22).
//
// A screenshot of a broken page, a photo of a label, a chart an agent rendered:
// before this, the only way to show one was to describe it, or to inline it as
// a data: URL inside an HTML document body, which put megabytes of base64 into
// the database row, into every export, and into the JSON mirror's history.
//
// So images are files, not fields. Each is stored once under the SHA-256 of its
// bytes (`<hash>.<ext>`) in a directory beside the database, and text refers to
// it with ordinary Markdown: `![alt](/api/images/<hash>.png)`. Content
// addressing makes an upload idempotent (the same screenshot twice is one file),
// makes the reference immutable (a name can never point at different bytes), and
// keeps the JSON export free of binary: the export copies the files into an
// `images/` folder next to the project files instead.
//
// There is no table and no delete, deliberately. The board is a record; a
// picture somebody decided on stays as evidence the same way the message
// quoting it does. The text that references an image is already signed and
// versioned, so the file itself needs no second copy of that.
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';

/**
 * Where a board's images live: `WORKBENCH_IMAGES`, else an `images/` folder
 * beside the database. Beside it, because the two are one installation's data
 * and are backed up, moved and deleted together.
 */
export function imagesDirFor(dbPath: string): string {
  return process.env.WORKBENCH_IMAGES || join(dirname(dbPath), 'images');
}

export const IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
} as const;
export type ImageExt = keyof typeof IMAGE_TYPES;

/**
 * Per image. A full-resolution retina screenshot is 2–6 MB as PNG; ten leaves
 * room for that and refuses the video someone renamed to .png. The content
 * repository commits every image, so the limit is also what keeps one upload
 * from making that repository unpleasant to clone.
 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * The largest request body an upload route will read: 10 MB of image as base64
 * is 13.3 MB, plus JSON or multipart overhead. A declared length above this is
 * refused before the body is buffered.
 */
export const MAX_IMAGE_REQUEST_BYTES = 14 * 1024 * 1024;

/** The one size refusal, for the stored file and for a declared request length. */
export function imageTooLarge(bytes: number): string {
  return `the image is ${(bytes / 1048576).toFixed(1)} MB; the limit is ${MAX_IMAGE_BYTES / 1048576} MB. Crop it or save it as JPEG or WebP.`;
}

/** The one shape an image reference may take, in a URL and in Markdown. */
export const IMAGE_NAME = /^([0-9a-f]{64})\.(png|jpg|gif|webp|svg)$/;
export const IMAGE_PATH_PREFIX = '/api/images/';

export class ImageRefused extends Error {
  statusCode = 400;
}

/**
 * The type from the bytes, never from what the sender called it. A declared
 * content type or file extension is a claim; the first bytes are the file.
 * Anything not one of the five is refused, so the server never serves a file
 * whose type it guessed.
 */
export function sniffImage(bytes: Uint8Array): ImageExt | undefined {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  // SVG is text: an optional BOM, XML declaration, comments or doctype, then
  // the root element. Only the opening is examined; svgRefusal reads the rest.
  const head = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, 2048)).replace(/^﻿/, '');
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(head)) return 'svg';
  return undefined;
}

/**
 * HEIC (and HEIF), the format a phone camera saves in. It is accepted at
 * upload and stored as a JPEG: no browser but Safari draws a HEIC inside
 * <img>, so a board that kept the bytes as they came would show a broken
 * picture to most readers, and a format the renderer and the export would
 * both have to learn is more surface than a camera default deserves. The
 * conversion runs through a converter already on the machine — `sips` on
 * macOS, else ImageMagick's `magick` or libheif's `heif-convert` — never a
 * dependency of this repository. A machine with none refuses the upload and
 * says what to do.
 *
 * Sniffed from the ISO base media header: a `ftyp` box whose major brand, or
 * one of whose compatible brands, is a HEIF brand carrying HEVC pictures.
 * `mif1`/`msf1` alone are shared with AVIF, so those count only with a HEIC
 * brand beside them.
 */
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']);
export function sniffHeic(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  const ascii = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (ascii(4) !== 'ftyp') return false;
  const size = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  const end = Math.min(bytes.length, size > 16 && size < 4096 ? size : 64);
  if (HEIC_BRANDS.has(ascii(8))) return true;
  for (let at = 16; at + 4 <= end; at += 4) if (HEIC_BRANDS.has(ascii(at))) return true;
  return false;
}

/**
 * The converter this machine has, as the argv that turns `in` into a JPEG at
 * `out`, or null. `WORKBENCH_HEIC_CONVERTER` names one (a command name or a
 * path; `none` turns conversion off, which the tests use to exercise the
 * refusal on a machine that has one). Looked up on each upload: a converter
 * installed while the board is running should work without a restart.
 */
export function heicConverter(): ((input: string, output: string) => string[]) | null {
  const named = process.env.WORKBENCH_HEIC_CONVERTER;
  if (named === 'none') return null;
  const candidates = named ? [named] : ['sips', 'magick', 'heif-convert'];
  for (const candidate of candidates) {
    const path = Bun.which(candidate);
    if (!path) continue;
    const name = basename(path);
    if (name === 'sips') return (input, output) => [path, '-s', 'format', 'jpeg', '-s', 'formatOptions', '90', input, '--out', output];
    if (name === 'magick' || name === 'convert') return (input, output) => [path, `${input}[0]`, '-quality', '90', output];
    return (input, output) => [path, '-q', '90', input, output];
  }
  return null;
}

export const HEIC_NO_CONVERTER =
  'HEIC is accepted only where this machine can convert it to JPEG (macOS sips, ImageMagick, or libheif heif-convert); none was found. Export the photo as JPEG and upload that.';

/** HEIC bytes in, JPEG bytes out, through the machine's converter. Throws ImageRefused with a reason. */
export function convertHeic(bytes: Uint8Array): Uint8Array {
  const converter = heicConverter();
  if (!converter) throw new ImageRefused(HEIC_NO_CONVERTER);
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const input = join(tmpdir(), `workbench-${stamp}.heic`);
  const output = join(tmpdir(), `workbench-${stamp}.jpg`);
  try {
    writeFileSync(input, bytes);
    // An argv, never a shell: the paths are ours, but the habit is the point.
    const run = Bun.spawnSync(converter(input, output), { stdout: 'ignore', stderr: 'pipe', timeout: 30_000 });
    if (run.exitCode !== 0 || !existsSync(output)) {
      const detail = new TextDecoder().decode(run.stderr || new Uint8Array()).trim().split('\n').pop() || `exit ${run.exitCode}`;
      throw new ImageRefused(`the HEIC could not be converted to JPEG (${detail}). Export it as JPEG and upload that.`);
    }
    const jpeg = new Uint8Array(readFileSync(output));
    if (sniffImage(jpeg) !== 'jpg') throw new ImageRefused('the HEIC converter did not produce a JPEG. Export it as JPEG and upload that.');
    return jpeg;
  } finally {
    for (const file of [input, output]) { try { rmSync(file, { force: true }); } catch {} }
  }
}

/**
 * An SVG is a document that can carry script. The guarantee that it stays
 * inert is how it is served and shown: a sandboxing CSP on the file, and
 * rendering through <img>, which runs no script. This check is a second,
 * best-effort line: common active content is refused at upload (script
 * elements, on… handlers, javascript: and other non-image URL schemes,
 * numeric entities hiding a scheme, foreignObject, embedded documents,
 * outside references). It is a denylist over text, so it is not a sanitizer
 * and must not be relied on as one. A drawing exported from a design tool has
 * none of these.
 */
export function svgRefusal(bytes: Uint8Array): string | undefined {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const checks: [RegExp, string][] = [
    // `<svg/onload=` and `a="1"onload=` have no whitespace before the name.
    [/<[\w:-]*script/i, 'a <script> element'],
    [/[\s/"'<]on[a-z]+\s*=/i, 'an on… event handler attribute'],
    [/javascript\s*:/i, 'a javascript: URL'],
    // An entity in an attribute value can spell a scheme (`&#106;avascript:`).
    [/=\s*"[^"]*&(?:#|colon;|tab;|newline;)|=\s*'[^']*&(?:#|colon;|tab;|newline;)/i, 'an entity-encoded attribute value'],
    [/<foreignObject[\s>/]/i, 'a <foreignObject> element'],
    [/<(?:iframe|embed|object)[\s>/]/i, 'an embedded document'],
    [/@import|url\(\s*["']?\s*(?:https?:|\/\/)/i, 'a stylesheet reference to an outside resource'],
  ];
  for (const [pattern, what] of checks) {
    if (pattern.test(text)) return `SVG refused: it contains ${what}. Export it without scripts or external references, or upload it as PNG.`;
  }
  // Every href/src/xlink:href may point only inside the drawing (#id) or at an
  // embedded image. Anything else (http:, file:, ftp:, //host, data:text/html,
  // a relative path) is a fetch or a navigation the drawing has no business making.
  const ref = /(?<![\w-])(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const m of text.matchAll(ref)) {
    const value = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!value.startsWith('#') && !/^data:image\//i.test(value)) {
      return 'SVG refused: it contains a reference to an outside resource. Export it without scripts or external references, or upload it as PNG.';
    }
  }
  return undefined;
}

export type StoredImage = {
  /** `<hash>.<ext>` — the file name and the last segment of `url`. */
  name: string;
  hash: string;
  type: string;
  bytes: number;
  url: string;
  /** Ready to paste into context, a message or a Markdown body. */
  markdown: string;
  /** True when these exact bytes were already stored. */
  existed: boolean;
};

/** Alt text on one line, without the characters that would end the Markdown. */
export function cleanAlt(alt: unknown): string {
  return typeof alt === 'string' ? alt.replace(/[\[\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

export class ImageStore {
  constructor(public readonly dir: string) {}

  /** Validate and store. Throws ImageRefused with a reason the sender can act on. */
  put(input: Uint8Array, alt?: unknown): StoredImage {
    let bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (!bytes.length) throw new ImageRefused('the image is empty');
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new ImageRefused(imageTooLarge(bytes.length));
    }
    // A HEIC becomes a JPEG before anything else looks at it, so the name,
    // the hash, the type and the Markdown are all the JPEG's. The same HEIC
    // twice converts to the same JPEG, so `existed` still holds for it.
    if (sniffHeic(bytes)) bytes = convertHeic(bytes);
    const ext = sniffImage(bytes);
    if (!ext) throw new ImageRefused('not an image this board stores: send PNG, JPEG, GIF, WebP, SVG or HEIC (the type is read from the bytes, not the file name)');
    if (ext === 'svg') {
      const refusal = svgRefusal(bytes);
      if (refusal) throw new ImageRefused(refusal);
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    const name = `${hash}.${ext}`;
    const file = join(this.dir, name);
    const existed = existsSync(file);
    if (!existed) {
      mkdirSync(this.dir, { recursive: true });
      // Written to a temporary name and renamed, so a crash mid-write never
      // leaves a truncated file under a hash it does not match.
      const tmp = join(this.dir, `.${name}.${process.pid}.${Date.now()}.tmp`);
      writeFileSync(tmp, bytes);
      renameSync(tmp, file);
    }
    const url = IMAGE_PATH_PREFIX + name;
    const label = cleanAlt(alt) || 'image';
    return { name, hash, type: IMAGE_TYPES[ext], bytes: bytes.length, url, markdown: `![${label}](${url})`, existed };
  }

  /** The file for a name, or null. The name is matched in full, so no path can escape the directory. */
  get(name: string): { path: string; type: string } | null {
    const m = IMAGE_NAME.exec(name);
    if (!m) return null;
    const path = join(this.dir, name);
    if (!existsSync(path)) return null;
    return { path, type: IMAGE_TYPES[m[2] as ImageExt] };
  }
}

/**
 * Copy every image in `from` that `to` lacks, and return how many were copied.
 * Used both ways: the export copies the board's images into the content
 * directory's `images/` folder, and the import copies them back. A file is
 * only copied if its name is a valid image name and its bytes hash to that
 * name, so a hand-edited or truncated file in a content repository is skipped
 * rather than served under a hash it does not match.
 */
export function copyImages(from: string, to: string, log?: (line: string) => void): number {
  if (!existsSync(from)) return 0;
  let copied = 0;
  for (const name of readdirSync(from)) {
    const m = IMAGE_NAME.exec(name);
    if (!m) continue;
    const target = join(to, name);
    // One unreadable or locked file must not stop the rest of the export (or
    // the project JSON that is written after this): log it and go on.
    try {
      if (existsSync(target)) continue;
      const bytes = readFileSync(join(from, name));
      if (createHash('sha256').update(bytes).digest('hex') !== m[1]) {
        log?.(`skipped image ${name}: its bytes do not match its name`);
        continue;
      }
      mkdirSync(to, { recursive: true });
      // Temporary name then rename, as put() does, so an interrupted copy
      // never leaves a truncated file under a hash it does not match.
      const tmp = join(to, `.${name}.${process.pid}.${Date.now()}.tmp`);
      try {
        writeFileSync(tmp, bytes);
        renameSync(tmp, target);
      } catch (error) {
        try { rmSync(tmp, { force: true }); } catch {}
        throw error;
      }
      copied += 1;
    } catch (error: any) {
      log?.(`skipped image ${name}: ${error?.message || error}`);
    }
  }
  return copied;
}

/** The headers every image is served with. */
export function imageHeaders(type: string): Record<string, string> {
  return {
    'content-type': type,
    // The bytes were checked on the way in; this stops a browser second-
    // guessing the type on the way out.
    'x-content-type-options': 'nosniff',
    // Opened directly (click to enlarge in a new tab), an SVG is a document.
    // This keeps it an inert one: no script, no fetches, its own origin.
    'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    'content-disposition': 'inline',
    // A name is the hash of the bytes, so the bytes behind it never change.
    'cache-control': 'public, max-age=31536000, immutable',
  };
}
