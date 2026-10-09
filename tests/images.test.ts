// Images (contract v22): upload, serve, render, back up, restore.
//
// Tested the way a writer meets them: a Request in, a Response out, for each
// of the three upload shapes; the headers a browser obeys; the Markdown the
// page draws from a reference; and the export and import that carry the
// files beside the JSON rather than inside it.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, Store } from '../src/db.ts';
import { createHandler, CONTRACT_VERSION } from '../src/app.ts';
import { exportAll, importAll } from '../src/export.ts';
import { sniffImage, svgRefusal, MAX_IMAGE_BYTES, copyImages } from '../src/images.ts';
import { itemBrief } from '../src/brief.ts';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { renderPage } from './helpers/page.ts';

const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;
const AGENTS_MD = new URL('../AGENTS.md', import.meta.url).pathname;

// A real 1x1 PNG, and the smallest headers each other format is known by.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'binary');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#b2451d"/></svg>');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

let root: string;
let store: Store;
let handler: (req: Request) => Promise<Response>;
let imagesDir: string;

beforeEach(() => {
  root = join(tmpdir(), `workbench-images-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  imagesDir = join(root, 'images');
  store = new Store(openDb(join(root, 'workbench.db')));
  handler = createHandler(store, { publicDir: PUBLIC_DIR, agentsMdPath: AGENTS_MD, imagesDir });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function send(method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) {
  const res = await handler(new Request(`http://localhost${path}`, { method, body, headers }));
  const buf = new Uint8Array(await res.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(new TextDecoder().decode(buf)); } catch {}
  return { status: res.status, json, buf, headers: res.headers };
}
const postJson = (path: string, body: unknown) => send('POST', path, JSON.stringify(body), { 'content-type': 'application/json' });

describe('size is checked before the body is read', () => {
  test('a declared oversize length is refused without reading the body', async () => {
    let pulled = false;
    const body = new ReadableStream({
      pull(controller) { pulled = true; controller.enqueue(new Uint8Array(8)); controller.close(); },
    });
    const req = new Request('http://localhost/api/images', {
      method: 'POST',
      body,
      // @ts-ignore duplex is required for a streamed body
      duplex: 'half',
      headers: { 'content-type': 'image/png', 'content-length': String(15 * 1024 * 1024) },
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain('the limit is 10 MB');
    expect(pulled).toBe(false);
  });

  test('a declared length within the cap goes on to the normal checks', async () => {
    const res = await send('POST', '/api/images', PNG, { 'content-type': 'image/png' });
    expect(res.status).toBe(201);
  });
});

describe('the type comes from the bytes', () => {
  test('each of the five formats is recognised, and nothing else', () => {
    expect(sniffImage(PNG)).toBe('png');
    expect(sniffImage(JPEG)).toBe('jpg');
    expect(sniffImage(GIF)).toBe('gif');
    expect(sniffImage(WEBP)).toBe('webp');
    expect(sniffImage(SVG)).toBe('svg');
    expect(sniffImage(Buffer.from('<html><body>hi</body></html>'))).toBeUndefined();
    expect(sniffImage(Buffer.from('%PDF-1.7'))).toBeUndefined();
    expect(sniffImage(Buffer.from('just text'))).toBeUndefined();
  });

  test('an SVG with anything active in it is refused, a plain drawing is not', () => {
    expect(svgRefusal(SVG)).toBeUndefined();
    const bad = [
      '<svg><script>alert(1)</script></svg>',
      '<svg onload="alert(1)"></svg>',
      '<svg><a href="javascript:alert(1)"><rect/></a></svg>',
      '<svg><foreignObject><div>x</div></foreignObject></svg>',
      '<svg><image href="https://example.invalid/x.png"/></svg>',
      '<svg><style>@import url(https://example.invalid/x.css);</style></svg>',
      '<svg><iframe src="x"></iframe></svg>',
      // evasions: no whitespace before the handler, other schemes, entities
      '<svg/onload=alert(1)></svg>',
      '<svg a="1"onload="alert(1)"></svg>',
      "<svg a='1'onclick='x()'></svg>",
      '<svg:script>alert(1)</svg:script>',
      '<svg><a href="&#106;avascript:alert(1)"><rect/></a></svg>',
      '<svg><a href="&#x6A;avascript:alert(1)"><rect/></a></svg>',
      '<svg><image href="file:///etc/passwd"/></svg>',
      '<svg><image xlink:href="ftp://example.invalid/x.png"/></svg>',
      '<svg><image href="relative/other.png"/></svg>',
      '<svg><image href=https://example.invalid/x.png /></svg>',
    ];
    for (const s of bad) expect(svgRefusal(Buffer.from(s))).toMatch(/^SVG refused/);
  });

  test('fragment and embedded-image references are still allowed', () => {
    const ok = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><rect id="r" width="1" height="1"/></defs><use xlink:href="#r"/><image href="data:image/png;base64,AAAA"/></svg>';
    expect(svgRefusal(Buffer.from(ok))).toBeUndefined();
  });
});

describe('POST /api/images', () => {
  test('raw bytes with an image content-type store the file and answer with its Markdown', async () => {
    const res = await send('POST', '/api/images?alt=login%20error', PNG, { 'content-type': 'image/png' });
    expect(res.status).toBe(201);
    const image = res.json.image;
    expect(image.name).toBe(`${sha(PNG)}.png`);
    expect(image.url).toBe(`/api/images/${sha(PNG)}.png`);
    expect(image.type).toBe('image/png');
    expect(image.bytes).toBe(PNG.length);
    expect(image.markdown).toBe(`![login error](/api/images/${sha(PNG)}.png)`);
    expect(image.existed).toBe(false);
    expect(readFileSync(join(imagesDir, image.name))).toEqual(PNG);
  });

  test('base64 JSON, and a data: URL, for an agent that can only write JSON', async () => {
    const a = await postJson('/api/images', { data: JPEG.toString('base64'), alt: 'shelf label' });
    expect(a.status).toBe(201);
    expect(a.json.image.name).toBe(`${sha(JPEG)}.jpg`);
    expect(a.json.image.markdown).toBe(`![shelf label](/api/images/${sha(JPEG)}.jpg)`);
    const b = await postJson('/api/images', { data: `data:image/gif;base64,${GIF.toString('base64')}`, name: 'spinner.gif' });
    expect(b.status).toBe(201);
    expect(b.json.image.type).toBe('image/gif');
    expect(b.json.image.markdown).toBe(`![spinner](/api/images/${sha(GIF)}.gif)`);
  });

  test('multipart, the shape curl -F sends', async () => {
    const form = new FormData();
    form.append('file', new File([WEBP], 'chart.webp', { type: 'image/webp' }));
    const res = await send('POST', '/api/images', form);
    expect(res.status).toBe(201);
    expect(res.json.image.name).toBe(`${sha(WEBP)}.webp`);
    expect(res.json.image.markdown).toBe(`![chart](/api/images/${sha(WEBP)}.webp)`);
  });

  test('the same bytes twice are one file: 200, same url, existed', async () => {
    const first = await send('POST', '/api/images', PNG, { 'content-type': 'image/png' });
    const again = await postJson('/api/images', { data: PNG.toString('base64') });
    expect(again.status).toBe(200);
    expect(again.json.image.url).toBe(first.json.image.url);
    expect(again.json.image.existed).toBe(true);
    expect(readdirSync(imagesDir).filter((n) => !n.startsWith('.'))).toEqual([first.json.image.name]);
  });

  test('a declared type is not trusted: HTML sent as image/png is refused', async () => {
    const res = await send('POST', '/api/images', '<html><script>alert(1)</script></html>', { 'content-type': 'image/png' });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('PNG, JPEG, GIF, WebP or SVG');
    expect(existsSync(imagesDir) ? readdirSync(imagesDir) : []).toEqual([]);
  });

  test('refusals say what to do: empty, too large, active SVG, no data, bad base64', async () => {
    expect((await send('POST', '/api/images', new Uint8Array(0), { 'content-type': 'image/png' })).json.error).toBe('the image is empty');
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    big.set(PNG.subarray(0, 8));
    const tooBig = await send('POST', '/api/images', big, { 'content-type': 'image/png' });
    expect(tooBig.status).toBe(400);
    expect(tooBig.json.error).toContain('the limit is 10 MB');
    const svg = await send('POST', '/api/images', '<svg onload="x()"></svg>', { 'content-type': 'image/svg+xml' });
    expect(svg.status).toBe(400);
    expect(svg.json.error).toContain('event handler');
    expect((await postJson('/api/images', { alt: 'x' })).json.error).toContain('{"data":"<base64>"}');
    expect((await postJson('/api/images', { data: '!!not base64!!' })).json.error).toBe('data is not base64');
  });

  test('unknown JSON fields are named in ignored, as on every other write', async () => {
    const res = await postJson('/api/images', { data: PNG.toString('base64'), caption: 'x', actor: 'a', session: 's' });
    expect(res.json.ignored).toEqual(['caption']);
  });

  test('a board started without an image directory says so instead of writing somewhere', async () => {
    const bare = createHandler(store, { publicDir: PUBLIC_DIR, agentsMdPath: AGENTS_MD });
    const res = await bare(new Request('http://localhost/api/images', { method: 'POST', body: PNG, headers: { 'content-type': 'image/png' } }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('no image directory');
  });
});

describe('GET /api/images/<name>', () => {
  test('serves the bytes with their real type, nosniff, and a sandboxing CSP', async () => {
    const up = await send('POST', '/api/images', SVG, { 'content-type': 'image/svg+xml' });
    const res = await send('GET', up.json.image.url);
    expect(res.status).toBe(200);
    expect(res.buf).toEqual(new Uint8Array(SVG));
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('sandbox');
    expect(csp).not.toContain('script-src');
    expect(res.headers.get('cache-control')).toContain('immutable');
  });

  test('only a full hash name resolves: no traversal, no other files', async () => {
    writeFileSync(join(root, 'secret.txt'), 'nope');
    for (const path of ['/api/images/..%2Fsecret.txt', '/api/images/secret.txt', `/api/images/${'a'.repeat(64)}.png`, `/api/images/${'a'.repeat(64)}.exe`]) {
      expect((await send('GET', path)).status).toBe(404);
    }
  });

  test('there is no delete', async () => {
    const up = await send('POST', '/api/images', PNG, { 'content-type': 'image/png' });
    const res = await send('DELETE', up.json.image.url);
    expect(res.status).toBe(405);
    expect(existsSync(join(imagesDir, up.json.image.name))).toBe(true);
  });

  test('the contract version is 22 and the routes list names the upload', async () => {
    const res = await send('GET', '/api');
    expect(res.json.contractVersion).toBe('22');
    expect(CONTRACT_VERSION).toBe('22');
    expect(res.json.routes.some((r: string) => r.includes('POST   /api/images'))).toBe(true);
    expect(readFileSync(AGENTS_MD, 'utf8')).toContain('### Images (v22)');
  });
});

describe('the page renders the board\'s own images, and only those', () => {
  const src = readFileSync(new URL('../public/md.js', import.meta.url), 'utf8');
  const win: any = {};
  new Function('window', src)(win);
  const MD = win.MD as ((md: string, opts?: { breaks?: boolean }) => string) & { inline: (s: string) => string };
  const hash = 'ab'.repeat(32);

  test('a reference becomes an image inside a link to the full file', () => {
    const html = MD(`Here it is:\n![login_page_error](/api/images/${hash}.png)`, { breaks: true });
    expect(html).toContain(`<a class="md-imglink" href="/api/images/${hash}.png" target="_blank" rel="noopener"><img class="md-img" src="/api/images/${hash}.png" alt="login_page_error" loading="lazy"></a>`);
    expect(html).not.toContain('<em>');
  });

  test('it renders in a document body, a list and a table cell too', () => {
    expect(MD(`- step one ![a](/api/images/${hash}.jpg)`)).toContain('<li>step one <a class="md-imglink"');
    expect(MD(`| Before | After |\n|---|---|\n| ![b](/api/images/${hash}.webp) | ![a](/api/images/${hash}.gif) |`)).toContain('<td><a class="md-imglink"');
  });

  test('an address anywhere else is never loaded', () => {
    const html = MD('![tracker](https://example.invalid/pixel.png)');
    expect(html).not.toContain('<img');
    expect(MD('![x](/api/images/../../etc/passwd)')).not.toContain('<img');
    expect(MD(`![x](/api/images/${hash}.png" onerror="alert(1))`)).not.toContain('<img');
  });

  test('alt text cannot break out of its attribute', () => {
    const html = MD(`![" onerror="alert(1)](/api/images/${hash}.png)`);
    expect(html).toContain('alt="&quot; onerror=&quot;alert(1)"');
    expect(html).not.toContain('" onerror="');
  });

  test('inside code it stays literal', () => {
    expect(MD(`\`![a](/api/images/${hash}.png)\``)).toBe(`<p><code>![a](/api/images/${hash}.png)</code></p>`);
  });
});

describe('the brief names an image instead of linking the board', () => {
  test('replaced with its alt text, the path left out', async () => {
    const project = store.createProject({ name: 'Demo', key: 'DEMO' });
    const item = store.createItem(project.id, { title: 'Which layout?', context: `Two layouts:\n![layout A, sidebar left](/api/images/${'cd'.repeat(32)}.png)\n![](/api/images/${'ef'.repeat(32)}.png)` });
    const brief = itemBrief(store.getItem(item.id)!, project);
    expect(brief).toContain('[image: layout A, sidebar left (on the board, not included)]');
    expect(brief).toContain('[image (on the board, not included)]');
    expect(brief).not.toContain('/api/images/');
  });
});

describe('backup and restore carry images as files beside the JSON', () => {
  test('export copies the files to images/, and the JSON holds only the reference', async () => {
    const up = await send('POST', '/api/images', PNG, { 'content-type': 'image/png' });
    const project = store.createProject({ name: 'Demo', key: 'DEMO' });
    const item = store.createItem(project.id, { title: 'Broken page' });
    store.addMessage(item.id, { who: 'agent', text: `Seen:\n${up.json.image.markdown}`, author: 'a' });
    const content = join(root, 'content');
    const result = exportAll(store, content, { imagesDir });
    expect(result.images).toBe(1);
    expect(readFileSync(join(content, 'images', up.json.image.name))).toEqual(PNG);
    const file = readFileSync(join(content, 'demo.json'), 'utf8');
    expect(file).toContain(up.json.image.url);
    expect(file).not.toContain(PNG.toString('base64'));
    // A second export copies nothing new.
    expect(exportAll(store, content, { imagesDir }).images).toBe(0);
  });

  test('import restores the files, and skips one whose bytes do not match its name', async () => {
    const content = join(root, 'content');
    mkdirSync(join(content, 'images'), { recursive: true });
    writeFileSync(join(content, 'images', `${sha(PNG)}.png`), PNG);
    writeFileSync(join(content, 'images', `${sha(JPEG)}.jpg`), Buffer.from('tampered'));
    writeFileSync(join(content, 'images', 'notes.txt'), 'ignored');
    const restored = join(root, 'restored-images');
    const lines: string[] = [];
    const result = importAll(store, content, (l) => lines.push(l), { imagesDir: restored });
    expect(result.images).toBe(1);
    expect(readdirSync(restored)).toEqual([`${sha(PNG)}.png`]);
    expect(lines.some((l) => l.includes('do not match'))).toBe(true);
  });

  test('copyImages with no source directory is a no-op', () => {
    expect(copyImages(join(root, 'nope'), join(root, 'out'))).toBe(0);
  });
});

describe('the reply box', () => {
  const find = (el: any, pred: (e: any) => boolean): any =>
    pred(el) ? el : (el.children || []).map((c: any) => find(c, pred)).find(Boolean);

  test('the item page offers an Image button beside Send, with a hidden image picker', async () => {
    const project = store.createProject({ name: 'Demo', key: 'DEMO' });
    const item = store.createItem(project.id, { title: 'Pick one' });
    const page = await renderPage(handler, 'item.html', `/p/demo/i/${item.id}`);
    const box = find(page.byId('panel'), (e) => e.className === 'replybox');
    const names = box.children.map((c: any) => c.tagName + '.' + c.className);
    expect(names).toEqual(['TEXTAREA.', 'SPAN.attachwrap', 'BUTTON.send']);
    const btn = find(box, (e) => e.className === 'attach');
    expect(btn.textContent).toBe('Image');
    const input = find(box, (e) => e.tagName === 'INPUT');
    expect(input.type).toBe('file');
    expect(input.hidden).toBe(true);
  });

  test('a click on a rendered image opens it over the page instead of leaving', async () => {
    const project = store.createProject({ name: 'Demo', key: 'DEMO' });
    const item = store.createItem(project.id, { title: 'Pick one' });
    const page = await renderPage(handler, 'item.html', `/p/demo/i/${item.id}`);
    const url = `/api/images/${'ab'.repeat(32)}.png`;
    const link: any = { getAttribute: () => url, querySelector: () => ({ alt: 'the chart' }) };
    let prevented = false;
    for (const fn of page.doc.listeners.click || []) {
      fn({ target: { closest: (sel: string) => (sel === 'a.md-imglink' ? link : null) }, button: 0, preventDefault: () => { prevented = true; } });
    }
    expect(prevented).toBe(true);
    const box = find(page.doc.body, (e) => e.id === 'wb-lightbox');
    expect(box.hidden).toBe(false);
    expect(find(box, (e) => e.tagName === 'IMG').src).toBe(url);
  });
});
