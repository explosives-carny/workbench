import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { checkPrDescription } from '../src/prDescription';

const template = readFileSync(new URL('../.github/pull_request_template.md', import.meta.url), 'utf8');

const good = `## Detail (for an agent)

Adds a required description check. src/prDescription.ts parses the two level-two
sections and counts words outside HTML comments; CI runs it on every pull request.

## Summary (for a project manager)

- Every change now explains itself in plain words.
`;

describe('pull request description rule', () => {
  it('accepts a description with both sections filled in', () => {
    expect(checkPrDescription(good)).toEqual({ ok: true, problems: [] });
  });

  it('refuses the untouched template — placeholder text lives in comments', () => {
    const result = checkPrDescription(template);
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(2);
  });

  it('refuses a description missing the project-manager summary', () => {
    const result = checkPrDescription(good.split('## Summary')[0]);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('missing section');
  });

  it('refuses an empty body', () => {
    expect(checkPrDescription('').problems).toHaveLength(2);
  });

  it('matches headings case-insensitively and stops at the next heading', () => {
    const body = good.replace('## Detail (for an agent)', '## detail (FOR AN AGENT)') + '\n## Notes\nextra';
    expect(checkPrDescription(body).ok).toBe(true);
  });

  it('the template carries both required headings', () => {
    expect(template).toContain('## Detail (for an agent)');
    expect(template).toContain('## Summary (for a project manager)');
  });
});
