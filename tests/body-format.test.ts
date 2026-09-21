// A document's format, when the writer did not say.
//
// An agent PUT a whole HTML page with no bodyFormat on 2026-09-21. It was
// stored as `text`, so the board rendered its source as escaped plain text in a
// <pre>: a set of wireframes arrived as a wall of markup. Nothing in the
// response said so — the item was created and the body stored whole — and the
// writer only found out by looking at the rendered page.
//
// These tests pin the inference and, just as importantly, pin how narrow it is.
// Guessing wrongly is worse than making the caller be explicit.

import { describe, it, expect } from 'bun:test';
import { inferBodyFormat, Store, openDb } from '../src/db.ts';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

describe('inferring a body format', () => {
  it('reads a full HTML document as html', () => {
    expect(inferBodyFormat('<!doctype html><html><head>…')).toBe('html');
    expect(inferBodyFormat('<!DOCTYPE HTML>\n<html lang="en">')).toBe('html');
    expect(inferBodyFormat('<html><body>hi</body></html>')).toBe('html');
  });

  it('ignores leading whitespace, which a heredoc leaves behind', () => {
    expect(inferBodyFormat('\n\n  <!doctype html><html>')).toBe('html');
  });

  it('reads a Markdown opening as markdown', () => {
    expect(inferBodyFormat('# Title\n\nsome prose')).toBe('markdown');
    expect(inferBodyFormat('- one\n- two')).toBe('markdown');
    expect(inferBodyFormat('1. first\n2. second')).toBe('markdown');
    expect(inferBodyFormat('> quoted')).toBe('markdown');
  });

  it('leaves anything else as text', () => {
    // A fragment of markup is NOT a document. Treating it as html would put a
    // snippet in a sandboxed frame with no stylesheet, which looks broken.
    expect(inferBodyFormat('<p>just a fragment</p>')).toBe('text');
    expect(inferBodyFormat('plain prose about a decision')).toBe('text');
    expect(inferBodyFormat('a # sign mid-sentence is not a heading')).toBe('text');
  });

  it('answers text for nothing at all', () => {
    expect(inferBodyFormat('')).toBe('text');
    expect(inferBodyFormat('   ')).toBe('text');
    expect(inferBodyFormat(undefined)).toBe('text');
    expect(inferBodyFormat(null)).toBe('text');
  });

  it('is not case sensitive about the doctype', () => {
    expect(inferBodyFormat('<!DocType HtMl>')).toBe('html');
  });
});

// The rule that matters most: an explicit format always wins. The inference
// exists to fill silence, never to override a caller who said what they meant.
describe('an explicit bodyFormat is never second-guessed', () => {
  it('is what the store does with it', () => {
    const store = new Store(openDb(join(tmpdir(), `wb-${randomUUID()}`, 'test.db')));
    const project = store.createProject({ name: 'Format' });
    const page = '<!doctype html><html><body>x</body></html>';

    const explicit = store.createItem(project.id, {
      title: 'html body, called text on purpose', kind: 'document', body: page, bodyFormat: 'text',
    });
    expect(store.getItem(explicit.id)!.bodyFormat).toBe('text');

    const inferred = store.createItem(project.id, {
      title: 'html body, nothing said', kind: 'document', body: page,
    });
    expect(store.getItem(inferred.id)!.bodyFormat).toBe('html');
  });
});

// An edit fails the same way a create did: a note replaced by a whole page.
describe('a body edit with no format named', () => {
  const page = '<!doctype html><html><body>x</body></html>';
  const fresh = () => {
    const store = new Store(openDb(join(tmpdir(), `wb-${randomUUID()}`, 'test.db')));
    return { store, project: store.createProject({ name: 'Edit' }) };
  };

  it('infers the format when the item is still plain text', () => {
    const { store, project } = fresh();
    const item = store.createItem(project.id, { title: 'note', kind: 'document', body: 'a short note' });
    expect(item.bodyFormat).toBe('text');
    expect(store.updateItem(item.id, { body: page })!.bodyFormat).toBe('html');
  });

  it('keeps a format the writer already chose', () => {
    const { store, project } = fresh();
    const item = store.createItem(project.id, { title: 'md', kind: 'document', body: '# Plan', bodyFormat: 'markdown' });
    expect(store.updateItem(item.id, { body: page })!.bodyFormat).toBe('markdown');
  });

  it('never overrides a format named on the edit', () => {
    const { store, project } = fresh();
    const item = store.createItem(project.id, { title: 'note', kind: 'document', body: 'a note' });
    expect(store.updateItem(item.id, { body: page, bodyFormat: 'text' })!.bodyFormat).toBe('text');
  });

  it('leaves the format alone when the body is not touched', () => {
    const { store, project } = fresh();
    const item = store.createItem(project.id, { title: 'note', kind: 'document', body: '# heading', bodyFormat: 'text' });
    expect(store.updateItem(item.id, { title: 'renamed' })!.bodyFormat).toBe('text');
  });
});
