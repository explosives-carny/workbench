/**
 * The pull request description rule (CONTRIBUTING.md, "How a pull request is
 * documented"): every description carries a filled-in agent-level section and
 * a filled-in plain-language summary. Checked in CI by scripts/check-pr-description.ts.
 *
 * A section counts as filled when, after removing HTML comments (the template's
 * placeholder text lives in comments), it has at least MIN_WORDS words.
 */
export const REQUIRED_SECTIONS = [
  { heading: 'Detail (for an agent)', minWords: 15 },
  { heading: 'Summary (for a project manager)', minWords: 5 },
] as const;

function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

/** The text under a level-2 heading, up to the next level-1 or level-2 heading. */
export function sectionText(body: string, heading: string): string | null {
  const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
  const wanted = heading.trim().toLowerCase();
  const start = lines.findIndex((line) => /^##\s+/.test(line) && line.replace(/^##\s+/, '').trim().toLowerCase() === wanted);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2}\s+/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** The template's tool-only confirmation, which must be ticked. */
export const TOOL_ONLY_CONFIRMATION = /^\s*-\s*\[[xX]\]\s*This changes the tool only/m;

export function checkPrDescription(body: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!TOOL_ONLY_CONFIRMATION.test(String(body || ''))) {
    problems.push('the "This changes the tool only" box is not ticked — a pull request carries no project data or installation configuration');
  }
  for (const { heading, minWords } of REQUIRED_SECTIONS) {
    const text = sectionText(body, heading);
    if (text === null) { problems.push(`missing section "## ${heading}"`); continue; }
    const words = stripComments(text).split(/\s+/).filter(Boolean).length;
    if (words < minWords) problems.push(`section "## ${heading}" is empty or still the template placeholder (needs at least ${minWords} words, has ${words})`);
  }
  return { ok: problems.length === 0, problems };
}
