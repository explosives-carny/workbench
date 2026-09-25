// CI entry point for the pull request description rule. Reads the body from
// the PR_BODY environment variable (set by .github/workflows/pr-description.yml).
import { checkPrDescription } from '../src/prDescription';

const result = checkPrDescription(process.env.PR_BODY || '');
if (result.ok) {
  console.log('pull request description: both sections present and filled in');
} else {
  console.error('pull request description does not meet CONTRIBUTING.md, "How a pull request is documented":');
  for (const problem of result.problems) console.error('  - ' + problem);
  process.exit(1);
}
