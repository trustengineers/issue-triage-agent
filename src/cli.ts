/**
 * Triage a repository's open issues and write a report.
 *
 *   pnpm triage --repo owner/name [--limit 10] [--out out]
 *   pnpm triage --fixture fixtures/issues.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderReport } from './report.js';
import { parseCli, runFromCli, runMain } from './run.js';

runMain(async () => {
  const args = parseCli(process.argv.slice(2));
  const result = await runFromCli(args);
  const report = renderReport(result);

  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, 'triage.md'), report);
  writeFileSync(join(args.out, 'triage.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(report);
  console.error(`Saved ${join(args.out, 'triage.md')} and ${join(args.out, 'triage.json')}`);
  return result.status === 'completed' ? 0 : 2;
});
