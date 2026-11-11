export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface AgentConfig {
  model: string;
  effort: Effort;
  /** Most model requests in one run. */
  maxTurns: number;
  /** Most tool calls in one run. */
  maxToolCalls: number;
  /** Most tokens in one run, counting every input token (cached or not) and every output token. */
  tokenBudget: number;
  /** Ask the API to re-run a request on a fallback model when a safety classifier declines it. */
  fallbacks: boolean;
}

export const DEFAULT_MODEL = 'claude-fable-5-2';

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const effort = (env.TRIAGE_EFFORT || 'medium') as Effort;
  if (!EFFORTS.includes(effort)) throw new Error(`TRIAGE_EFFORT must be one of ${EFFORTS.join(', ')}, got "${effort}"`);
  return {
    model: env.ANTHROPIC_MODEL || DEFAULT_MODEL,
    effort,
    maxTurns: int(env, 'TRIAGE_MAX_TURNS', 40),
    maxToolCalls: int(env, 'TRIAGE_MAX_TOOL_CALLS', 150),
    tokenBudget: int(env, 'TRIAGE_TOKEN_BUDGET', 1_000_000),
    fallbacks: (env.TRIAGE_FALLBACKS || 'on').toLowerCase() !== 'off',
  };
}

/** Loads a .env file from the working directory if there is one. Real environment variables win. */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    /* no .env file */
  }
}
