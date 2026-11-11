/**
 * Run the agent on the labeled fixture and score it.
 *
 *   pnpm eval [--fixture fixtures/issues.json] [--out out]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { renderEval, scoreRun, type ExpectedSet } from './eval.js';
import { parseCli, runFromCli, runMain } from './run.js';

runMain(async () => {
  const args = parseCli(process.argv.slice(2), { fixture: 'fixtures/issues.json' });
  if (!args.fixture) throw new Error('The eval runs on a fixture, not on a live repository.');
  const expected = JSON.parse(readFileSync(join(dirname(args.fixture), 'expected.json'), 'utf8')) as ExpectedSet;

  const result = await runFromCli({ ...args, limit: 50 });
  const report = renderEval(scoreRun(result, expected), result);

  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, 'eval.md'), report);
  console.log(report);
  console.error(`Saved ${join(args.out, 'eval.md')}`);
  return result.status === 'completed' ? 0 : 2;
});
