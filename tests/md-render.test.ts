// The page renders an item's context and messages as Markdown (contract v20),
// through the same hand-written md.js that renders document bodies. These
// tests load the browser file as the page does and pin the two modes, the
// inline renderer used by option buttons, and that nothing in a context can
// reach the page as live HTML.
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';

const src = readFileSync(new URL('../public/md.js', import.meta.url), 'utf8');
const win: any = {};
new Function('window', src)(win);
const MD = win.MD as ((md: string, opts?: { breaks?: boolean }) => string) & { inline: (s: string) => string };

const decision = [
  'One lead sentence.',
  '- **What posts:** the difference',
  '- **Why:** later moves stay intact',
  '',
  '| Reason | Posts | As |',
  '|---|---|---|',
  '| Record error | Adjustment | Physical count |',
  '| Found in another bin | Nothing | — |',
  '',
  '**Recommendation: A.**',
].join('\n');

describe('context and message mode (breaks)', () => {
  test('a decision context renders its list, table and bold', () => {
    const html = MD(decision, { breaks: true });
    expect(html).toContain('<ul><li><strong>What posts:</strong> the difference</li>');
    expect(html).toContain('<thead><tr><th>Reason</th><th>Posts</th><th>As</th></tr></thead>');
    expect((html.match(/<tr>/g) || []).length).toBe(3);
    expect(html).toContain('<p><strong>Recommendation: A.</strong></p>');
    expect(html).not.toContain('**');
    expect(html).not.toContain('|---');
  });

  test('a single newline in a reply is kept as a line break', () => {
    expect(MD('Looks right.\nShip it after lunch.', { breaks: true })).toBe('<p>Looks right.<br>Ship it after lunch.</p>');
  });

  test('a quote keeps the mode it was rendered in', () => {
    expect(MD('> one\n> two', { breaks: true })).toBe('<blockquote><p>one<br>two</p></blockquote>');
  });
});

describe('document mode (default)', () => {
  test('a single newline only wraps the source, as Markdown does', () => {
    expect(MD('one\ntwo')).toBe('<p>one two</p>');
  });

  test('null and undefined render nothing', () => {
    expect(MD(undefined as any, { breaks: true })).toBe('');
  });
});

describe('option buttons (inline)', () => {
  test('inline formatting renders and no block wrapper is added', () => {
    expect(MD.inline('**A.** keep `p1`')).toBe('<strong>A.</strong> keep <code>p1</code>');
  });
});

describe('nothing in the text becomes live HTML', () => {
  const hostile = '<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1)) "q"';
  for (const [name, html] of [
    ['context', MD(hostile, { breaks: true })],
    ['document', MD(hostile)],
    ['option', MD.inline(hostile)],
  ] as const) {
    test(`${name}: tags are escaped and a javascript: link is not an anchor`, () => {
      expect(html).not.toContain('<script');
      expect(html).not.toContain('<img');
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('href="javascript');
    });
  }
});
