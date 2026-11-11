import { parseArgs } from 'node:util';
import { AnthropicModel, runTriage, type AgentEvent } from './agent.js';
import { loadConfig, loadDotEnv } from './config.js';
import { FixtureSource, GitHubSource } from './source.js';
import type { IssueSource, RunResult } from './types.js';

export interface CliArgs {
  repo?: string;
  fixture?: string;
  limit: number;
  out: string;
  quiet: boolean;
}

export function parseCli(argv: string[], defaults: { fixture?: string } = {}): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      fixture: { type: 'string' },
      limit: { type: 'string', default: '10' },
      out: { type: 'string', default: 'out' },
      quiet: { type: 'boolean', default: false },
    },
  });
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error(`--limit must be a whole number from 1 to 50, got "${values.limit}"`);
  if (values.repo && values.fixture) throw new Error('Use --repo or --fixture, not both.');
  const fixture = values.fixture ?? (values.repo ? undefined : defaults.fixture);
  if (!values.repo && !fixture) throw new Error('Pass --repo owner/name or --fixture path/to/issues.json.');
  return { ...(values.repo ? { repo: values.repo } : {}), ...(fixture ? { fixture } : {}), limit, out: values.out, quiet: values.quiet };
}

function logEvent(event: AgentEvent): void {
  const input = JSON.stringify(event.input);
  const shown = input.length > 110 ? `${input.slice(0, 110)}…` : input;
  const note = event.isError ? `  REJECTED: ${event.result.slice(0, 160)}` : '';
  console.error(`  [request ${event.turn}] ${event.tool} ${shown}${note}`);
}

/** Shared by the triage and eval commands: build the source, run the agent, show progress. */
export async function runFromCli(args: CliArgs): Promise<RunResult> {
  loadDotEnv();
  const config = loadConfig();
  const source: IssueSource = args.fixture ? FixtureSource.fromFile(args.fixture) : new GitHubSource(args.repo!, process.env.GITHUB_TOKEN || undefined);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error('No model credentials found. Put ANTHROPIC_API_KEY in .env (see .env.example).');
  }
  console.error(`Triaging up to ${args.limit} open issues of ${source.repo} with ${config.model}...`);
  return runTriage({ source, model: new AnthropicModel(config), config, limit: args.limit, ...(args.quiet ? {} : { onEvent: logEvent }) });
}

/** Runs a command's main function; errors become one line and exit code 1. */
export function runMain(main: () => Promise<number>): void {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
