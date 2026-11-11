import type { ModelClient, ModelRequest, ModelTurn, ToolUse } from '../src/agent.js';
import type { AgentConfig } from '../src/config.js';
import { FixtureSource } from '../src/source.js';
import type { Issue, Triage } from '../src/types.js';

export const config: AgentConfig = {
  model: 'test-model',
  effort: 'medium',
  maxTurns: 10,
  maxToolCalls: 20,
  tokenBudget: 100_000,
  fallbacks: false,
};

export function issue(number: number, title: string, body = '', extra: Partial<Issue> = {}): Issue {
  const day = String(number % 28 || 1).padStart(2, '0');
  return {
    number,
    title,
    body,
    state: 'open',
    labels: [],
    author: 'tester',
    createdAt: `2026-01-${day}T00:00:00Z`,
    updatedAt: `2026-01-${day}T00:00:00Z`,
    comments: 0,
    ...extra,
  };
}

export function source(issues: Issue[] = [issue(1, 'Crash on empty config'), issue(2, 'Add a --check flag')]): FixtureSource {
  return new FixtureSource({
    repo: 'acme/demo',
    labels: [{ name: 'bug' }, { name: 'enhancement' }, { name: 'Needs-Info', description: 'Waiting for the reporter' }],
    issues,
  });
}

export function triage(issue_number: number, extra: Partial<Triage> = {}): Triage {
  return {
    issue_number,
    type: 'bug',
    priority: 'P2',
    labels: ['bug'],
    duplicate_of: null,
    needs_info: false,
    questions: [],
    summary: 'A summary.',
    rationale: 'A rationale.',
    confidence: 'high',
    ...extra,
  };
}

let nextId = 0;

/** A scripted model turn: optional text and any number of tool calls. */
export function turn(text: string, calls: Array<[name: string, input: unknown]> = [], stopReason?: string, tokens = 100): ModelTurn {
  const toolUses: ToolUse[] = calls.map(([name, input]) => ({ id: `call_${++nextId}`, name, input }));
  return {
    content: [...(text ? [{ type: 'text', text }] : []), ...toolUses.map((t) => ({ type: 'tool_use', ...t }))],
    toolUses,
    text,
    stopReason: stopReason ?? (toolUses.length ? 'tool_use' : 'end_turn'),
    usage: { inputTokens: tokens, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 },
  };
}

/** Plays back a fixed list of turns and records every request it was sent. */
export class ScriptedModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly turns: ModelTurn[]) {}

  async send(request: ModelRequest): Promise<ModelTurn> {
    // The loop reuses one messages array, so keep a copy of what it looked like at this point.
    this.requests.push({ ...request, messages: [...request.messages] });
    const next = this.turns.shift();
    if (!next) throw new Error('ScriptedModel ran out of turns');
    return next;
  }
}

/** The tool results the loop sent back in request `index` (the last user message). */
export function resultsOf(model: ScriptedModel, index: number): Array<{ content: string; is_error?: boolean }> {
  return model.requests[index]!.messages.at(-1)!.content as Array<{ content: string; is_error?: boolean }>;
}
