import { readFileSync } from 'node:fs';

/**
 * The parts of a CI run that a reviewer should not have to download to read.
 *
 * The job summary already carried what Vitest writes into it. What it did not
 * carry was coverage, which lives in an artefact, or the end-to-end run, which
 * lived in an annotation under the fold. Both are one line each and both are
 * the kind of number somebody glances at before approving.
 *
 * A script rather than `node -e` in the workflow, for one reason: the workflow
 * cannot be run here and this can. Every branch below has been exercised
 * against a real file from a real run.
 *
 * Prints markdown to stdout. A missing input prints nothing and exits zero -
 * the step that failed has already said so, and a summary that fails to render
 * a summary of a failure helps nobody.
 */

const [, , what] = process.argv;

function read(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** A duration a person reads, from milliseconds. */
function took(ms) {
  const seconds = Math.round(ms / 1000);
  return seconds < 60
    ? `${String(seconds)}s`
    : `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`;
}

function coverage() {
  const summary = read('coverage/coverage-summary.json');
  if (summary === null) return '';

  const total = summary.total;
  // The floors are in `vitest.config.mts` and are not repeated here: breaching
  // one fails the run, so a second copy of the numbers could only ever disagree
  // with the one that decides.
  const rows = ['lines', 'statements', 'functions', 'branches']
    .filter((metric) => total[metric] !== undefined)
    .map(
      (metric) =>
        `| ${metric} | ${total[metric].pct.toFixed(2)}% | ${String(total[metric].covered)} / ${String(total[metric].total)} |`,
    );

  return [
    '## Coverage',
    '',
    'Of `packages/*/src`, from the unit run. The database suite is excluded and covered separately.',
    '',
    '| | covered | of |',
    '| --- | ---: | ---: |',
    ...rows,
    '',
  ].join('\n');
}

function endToEnd() {
  const report = read('apps/web/playwright-report/results.json');
  if (report === null) return '';

  const { expected = 0, unexpected = 0, flaky = 0, skipped = 0, duration = 0 } = report.stats ?? {};

  const counts = [];
  if (unexpected > 0) counts.push(`❌ **${String(unexpected)} failed**`);
  if (expected > 0) counts.push(`✅ **${String(expected)} passed**`);
  if (flaky > 0) counts.push(`⚠️ ${String(flaky)} flaky`);
  if (skipped > 0) counts.push(`${String(skipped)} skipped`);

  return [
    '## End-to-end',
    '',
    'The application rendered in a browser, against a real database.',
    '',
    `- **Tests**: ${counts.join(' · ')} · ${took(duration)}`,
    '',
  ].join('\n');
}

const rendered = what === 'coverage' ? coverage() : what === 'e2e' ? endToEnd() : '';

// Opened with a blank line, because what it is appended to is Vitest's block
// and that does not end with one: without this the heading below sits against
// the last bullet above it.
if (rendered !== '') process.stdout.write(`\n${rendered}\n`);
