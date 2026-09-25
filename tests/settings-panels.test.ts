import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

// The board is a static page with no build step, so the settings panels on
// public/project.html and public/index.html are read as text, the same way
// tests/store.test.ts already reads project.html to check it mirrors the
// grouping tables. There is no DOM here — just the two things worth proving
// without a browser: the panel offers exactly the values the server accepts,
// and it offers exactly the fields the brief asked for, nothing invented and
// nothing left out.
const appTs = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
const projectHtml = readFileSync(new URL('../public/project.html', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

// The server's own validation is the one place these lists are declared —
// pulling them out here rather than retyping them means a future value added
// to app.ts (or removed from it) fails this test instead of silently leaving
// the panel offering a choice the server refuses, or missing one it accepts.
function allowedByServer(field: string): string[] {
  const re = new RegExp(`!\\[([^\\]]*)\\]\\.includes\\(body\\.${field}\\)`);
  const m = appTs.match(re);
  expect(m).not.toBeNull();
  return m![1].split(',').map((s) => s.trim().replace(/^'/, '').replace(/'$/, ''));
}

function selectOptionValues(html: string, field: string): string[] {
  const re = new RegExp(`<select[^>]*data-field="${field}"[^>]*>([\\s\\S]*?)</select>`);
  const m = html.match(re);
  expect(m).not.toBeNull();
  return [...m![1].matchAll(/<option value="([^"]*)"/g)].map((mm) => mm[1]);
}

// The whole panel's fields, so "exactly these and no others" can be asserted
// in one line rather than one missing-field test per field.
function panelFields(html: string): string[] {
  const start = html.indexOf('<details class="settings"');
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf('</details>', start);
  expect(end).toBeGreaterThan(start);
  const body = html.slice(start, end);
  return [...new Set([...body.matchAll(/data-field="([^"]+)"/g)].map((m) => m[1]))].sort();
}

describe('project settings panel (public/project.html)', () => {
  it('offers the same groupBy values the server accepts, same order', () => {
    expect(selectOptionValues(projectHtml, 'groupBy')).toEqual(allowedByServer('groupBy'));
  });

  it('offers the same sortBy values the server accepts, same order', () => {
    expect(selectOptionValues(projectHtml, 'sortBy')).toEqual(allowedByServer('sortBy'));
  });

  it('offers the same sectionMode values the server accepts, same order', () => {
    expect(selectOptionValues(projectHtml, 'sectionMode')).toEqual(allowedByServer('sectionMode'));
  });

  it('has controls for exactly groupBy, sortBy, name, description, key, color, sectionMode, sections, repos, archived', () => {
    expect(panelFields(projectHtml)).toEqual(
      ['archived', 'color', 'description', 'groupBy', 'key', 'name', 'repos', 'sectionMode', 'sections', 'sortBy'].sort()
    );
  });

  it('hides the Add-item Section box for status AND move, not status alone', () => {
    expect(projectHtml).toContain(
      "document.getElementById('isection').hidden = project.groupBy === 'status' || project.groupBy === 'move';"
    );
  });

  it('includes sortBy in signature() next to groupBy, so a change repaints', () => {
    const start = projectHtml.indexOf('function signature()');
    expect(start).toBeGreaterThan(-1);
    const end = projectHtml.indexOf('\n  }', start);
    const body = projectHtml.slice(start, end);
    expect(body).toContain('project && project.groupBy');
    expect(body).toContain('project && project.sortBy');
  });

  it('saves a select change immediately and redraws', () => {
    // "Immediately" means the change handler, not a Save button, and the
    // redraw is the documented load(true) — a stale select that silently
    // waits for the 5s poll would look broken, not merely slow.
    expect(projectHtml).toContain("saveProjectField('groupBy', e.target.value)");
    expect(projectHtml).toContain("saveProjectField('sortBy', e.target.value)");
    expect(projectHtml).toContain('await load(true);');
  });
});

describe('board settings panel (public/index.html)', () => {
  it('has controls for exactly the onboarding keys plus agentNames, and no autoMode', () => {
    const fields = panelFields(indexHtml);
    expect(fields).not.toContain('autoMode');
    expect(fields).toEqual(
      ['agentNames', 'autoCapture', 'backupPlan', 'checkInOnStart', 'defaultProject', 'onboardedAt', 'postFindings', 'summariseOnExit'].sort()
    );
  });

  it('never mentions autoMode anywhere on the page', () => {
    expect(indexHtml).not.toContain('autoMode');
  });

  it('saves each control through PATCH /api/settings', () => {
    expect(indexHtml).toContain("WB.patch('/api/settings'");
  });
});

describe('the colour picker mirrors PROJECT_COLORS exactly', () => {
  it('project.html\'s local palette array matches src/db.ts, so the two cannot drift apart', () => {
    const dbTs = readFileSync(new URL('../src/db.ts', import.meta.url), 'utf8');
    const dbMatch = dbTs.match(/export const PROJECT_COLORS = \[([\s\S]*?)\] as const;/);
    expect(dbMatch).not.toBeNull();
    const dbColors = [...dbMatch![1].matchAll(/'(#[0-9a-fA-F]{6})'/g)].map((m) => m[1]);
    expect(dbColors.length).toBe(12);

    const pageMatch = projectHtml.match(/const PROJECT_COLORS = \[([\s\S]*?)\];/);
    expect(pageMatch).not.toBeNull();
    const pageColors = [...pageMatch![1].matchAll(/'(#[0-9a-fA-F]{6})'/g)].map((m) => m[1]);
    expect(pageColors).toEqual(dbColors);
  });
});
