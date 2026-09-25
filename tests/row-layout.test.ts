import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

// Source-level checks, the same way settings-panels.test.ts reads the pages as
// text rather than driving a browser: a board row with a long title, several
// labels and a busy meta cluster must still show the title, which is the one
// thing the row exists for.
const projectHtml = readFileSync(new URL('../public/project.html', import.meta.url), 'utf8');
const appCss = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function renderRowBody(): string {
  const start = projectHtml.indexOf('function renderRow(item)');
  expect(start).toBeGreaterThan(-1);
  const end = projectHtml.indexOf('\n  function statusChip', start);
  expect(end).toBeGreaterThan(start);
  return projectHtml.slice(start, end);
}

describe('row layout: the title always shows', () => {
  it('sets title= on the title link to the full text', () => {
    const body = renderRowBody();
    expect(body).toMatch(/t\.title\s*=\s*item\.title/);
  });

  it('collapses labels beyond the first two into a "+N" chip', () => {
    const body = renderRowBody();
    expect(body).toContain('labels.slice(0, 2)');
    expect(body).toMatch(/'\+'\s*\+\s*hiddenLabels\.length/);
    // The overflow chip names what it is hiding, so the information is one
    // hover away rather than simply gone.
    expect(body).toMatch(/more\.title\s*=\s*hiddenLabels\.join/);
  });

  it('shows a compact relative time and author, with the full signature in title=', () => {
    const body = renderRowBody();
    expect(body).toContain('WB.relTime(whenIso)');
    expect(body).toMatch(/who\.title\s*=\s*fullWho/);
  });

  it('gives the title link a guaranteed grow-and-floor share of the row, and clamps it to two lines', () => {
    expect(appCss).toMatch(/a\.lr-title\s*\{[^}]*flex:\s*1 1 auto/);
    expect(appCss).toMatch(/a\.lr-title\s*\{[^}]*min-width:\s*min\(40%,\s*12rem\)/);
    expect(appCss).toMatch(/a\.lr-title\s*\{[^}]*-webkit-line-clamp:\s*2/);
  });

  it('keeps everything else in the row flex:none or shrinkable, never forcing the title out', () => {
    expect(appCss).toMatch(/\.lr-doc\s*\{[^}]*flex:\s*none/);
    expect(appCss).toMatch(/\.lr-label\s*\{[^}]*flex:\s*none/);
  });

  it('exposes a relative-time helper from app.js for the row to use', () => {
    expect(appJs).toContain('function relTime(iso)');
    expect(appJs).toMatch(/relTime,?\s*\n?\s*\};/);
  });
});

describe('row layout: the item page heading is never clipped', () => {
  it('lets the h1 shrink and wrap rather than overflow, at every width', () => {
    expect(appCss).toMatch(/\.titlerow h1\s*\{[^}]*min-width:\s*0/);
    expect(appCss).toMatch(/\.titlerow h1\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it('keeps the ref chip beside it from forcing a squeeze (the row wraps instead)', () => {
    expect(appCss).toMatch(/\.titlerow\s*\{[^}]*flex-wrap:\s*wrap/);
  });
});
