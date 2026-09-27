import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

// public/app.js is a plain script (window.WB = (function () {...})()), not an
// ES module, so it cannot be imported the way src/*.ts is — the rest of the
// file reaches into `document` and `navigator` this test never provides.
// `formatItemPlainText` is deliberately pure and self-contained (it takes
// statusLabels as an argument rather than closing over WB.STATUS_LABELS) so
// it can be pulled out of the source and actually run, the same way
// row-layout.test.ts reads the source as text rather than driving a browser.
const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function loadFormatItemPlainText(): (item: any, statusLabels?: Record<string, string>) => string {
  const start = appJs.indexOf('function formatItemPlainText(item, statusLabels) {');
  expect(start).toBeGreaterThan(-1);
  const end = appJs.indexOf('\n  return {', start);
  expect(end).toBeGreaterThan(start);
  const source = appJs.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(`return (${source});`)();
}

const STATUS_LABELS = {
  'needs-decision': 'Decision',
  'needs-qa': 'QA',
  received: 'Received',
  'in-progress': 'Working',
  blocked: 'Blocked',
  deferred: 'Deferred',
  active: 'Active',
  archived: 'Archived',
  complete: 'Complete',
  cancelled: 'Cancelled',
};

describe('formatItemPlainText: the "Copy item" plain text', () => {
  it('leads with the ref and title, then the status', () => {
    const formatItemPlainText = loadFormatItemPlainText();
    const text = formatItemPlainText({ ref: 'WB-DEMO-14', title: 'Ship the thing', status: 'needs-decision' }, STATUS_LABELS);
    const lines = text.split('\n');
    expect(lines[0]).toBe('WB-DEMO-14  Ship the thing');
    expect(lines[1]).toBe('Status: Decision');
  });

  it('falls back to the title alone when there is no ref yet', () => {
    const formatItemPlainText = loadFormatItemPlainText();
    const text = formatItemPlainText({ ref: null, title: 'A project with no key', status: 'received' }, STATUS_LABELS);
    expect(text.split('\n')[0]).toBe('A project with no key');
  });

  it('includes the context as its own paragraph when present, and omits it otherwise', () => {
    const formatItemPlainText = loadFormatItemPlainText();
    const withCtx = formatItemPlainText(
      { ref: 'WB-DEMO-1', title: 'T', status: 'received', context: 'Why this matters.' },
      STATUS_LABELS,
    );
    expect(withCtx).toContain('\n\nWhy this matters.');

    const withoutCtx = formatItemPlainText({ ref: 'WB-DEMO-1', title: 'T', status: 'received' }, STATUS_LABELS);
    expect(withoutCtx).not.toContain('Why this matters.');
  });

  it('lays out the whole thread under a Discussion heading, naming who said each thing', () => {
    const formatItemPlainText = loadFormatItemPlainText();
    const text = formatItemPlainText(
      {
        ref: 'WB-DEMO-1',
        title: 'T',
        status: 'received',
        messages: [
          { who: 'agent', author: 'Sparks', text: 'Tried the migration; one step failed.' },
          { who: 'you', text: 'Looks fine, ship it.' },
        ],
      },
      STATUS_LABELS,
    );
    expect(text).toContain('Discussion:');
    expect(text).toContain('Sparks:');
    expect(text).toContain('Tried the migration; one step failed.');
    expect(text).toContain('You:');
    expect(text).toContain('Looks fine, ship it.');
    // The agent's line comes before the reply, matching thread order.
    expect(text.indexOf('Sparks:')).toBeLessThan(text.indexOf('You:'));
  });

  it('names an unauthored agent message plainly as "Agent"', () => {
    const formatItemPlainText = loadFormatItemPlainText();
    const text = formatItemPlainText(
      { ref: 'WB-DEMO-1', title: 'T', status: 'received', messages: [{ who: 'agent', text: 'No author on this one.' }] },
      STATUS_LABELS,
    );
    expect(text).toContain('Agent:');
  });

  it('omits the Discussion section entirely when there are no messages', () => {
    const formatItemPlainText = loadFormatItemPlainText();
    const text = formatItemPlainText({ ref: 'WB-DEMO-1', title: 'T', status: 'received', messages: [] }, STATUS_LABELS);
    expect(text).not.toContain('Discussion:');
  });

  it('falls back to the raw status when the label map has nothing for it', () => {
    const formatItemPlainText = loadFormatItemPlainText();
    const text = formatItemPlainText({ ref: 'WB-DEMO-1', title: 'T', status: 'some-new-status' }, {});
    expect(text).toContain('Status: some-new-status');
  });
});
