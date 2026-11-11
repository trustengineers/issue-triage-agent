import { describe, expect, it } from 'vitest';
import { runTriage, SYSTEM_PROMPT, type AgentEvent } from '../src/agent.js';
import { config, resultsOf, ScriptedModel, source, triage, turn } from './helpers.js';

describe('runTriage', () => {
  it('runs the tools the model asks for and finishes when every issue is recorded', async () => {
    const model = new ScriptedModel([
      turn('', [['list_issues', {}]]),
      turn('', [
        ['get_issue', { number: 1 }],
        ['search_issues', { query: 'empty config' }],
      ]),
      turn('', [
        ['record_triage', triage(1)],
        ['record_triage', triage(2, { type: 'feature', labels: ['enhancement'] })],
      ]),
      turn('Two issues triaged.'),
    ]);
    const events: AgentEvent[] = [];
    const result = await runTriage({ source: source(), model, config, limit: 10, onEvent: (e) => events.push(e) });

    expect(result).toMatchObject({ status: 'completed', missing: [], turns: 4, toolCalls: 5, rejectedToolCalls: 0, finalText: 'Two issues triaged.' });
    expect(result.triage.map((t) => [t.issue_number, t.type])).toEqual([
      [2, 'feature'],
      [1, 'bug'],
    ]);
    expect(result.usage).toMatchObject({ inputTokens: 400, outputTokens: 40 });
    expect(events.map((e) => e.tool)).toEqual(['list_issues', 'get_issue', 'search_issues', 'record_triage', 'record_triage']);

    // First request: system prompt, the four tools, and the repository's labels.
    expect(model.requests[0]!.system).toBe(SYSTEM_PROMPT);
    expect(model.requests[0]!.tools).toHaveLength(4);
    expect(model.requests[0]!.messages[0]!.content).toContain('- Needs-Info: Waiting for the reporter');
    // Both results of a two-call turn go back in one user message.
    expect(resultsOf(model, 2)).toHaveLength(2);
  });

  it('sends a rejected call back as an error so the model can correct it', async () => {
    const model = new ScriptedModel([
      turn('', [
        ['record_triage', triage(1, { labels: ['critical'] })],
        ['record_triage', triage(2)],
      ]),
      turn('', [['record_triage', triage(1)]]),
      turn('Done.'),
    ]);
    const result = await runTriage({ source: source(), model, config, limit: 10 });
    expect(result).toMatchObject({ status: 'completed', toolCalls: 3, rejectedToolCalls: 1 });
    const [rejected, accepted] = resultsOf(model, 1);
    expect(rejected).toMatchObject({ is_error: true, content: expect.stringContaining('Unknown label(s): critical') });
    expect(accepted!.is_error).toBeUndefined();
  });

  it('reminds the model once about unrecorded issues, then gives up', async () => {
    const model = new ScriptedModel([turn('', [['record_triage', triage(1)]]), turn('All done.'), turn('Really done.')]);
    const result = await runTriage({ source: source(), model, config, limit: 10 });
    expect(result).toMatchObject({ status: 'incomplete', missing: [2], turns: 3 });
    expect(model.requests[2]!.messages.at(-1)!.content).toContain('no record yet: #2');
  });

  it('stops at the model-request limit', async () => {
    const model = new ScriptedModel(Array.from({ length: 5 }, () => turn('', [['list_issues', {}]])));
    const result = await runTriage({ source: source(), model, config: { ...config, maxTurns: 3 }, limit: 10 });
    expect(result).toMatchObject({ status: 'max_turns', turns: 3, missing: [2, 1] });
  });

  it('stops at the tool-call limit and does not run calls beyond it', async () => {
    const model = new ScriptedModel([
      turn('', [
        ['record_triage', triage(1)],
        ['list_issues', {}],
        ['record_triage', triage(2)],
      ]),
    ]);
    const result = await runTriage({ source: source(), model, config: { ...config, maxToolCalls: 2 }, limit: 10 });
    expect(result).toMatchObject({ status: 'max_tool_calls', toolCalls: 2, missing: [2] });
  });

  it('stops when the token budget is used up', async () => {
    const model = new ScriptedModel([turn('', [['list_issues', {}]], undefined, 600), turn('', [['list_issues', {}]], undefined, 600)]);
    const result = await runTriage({ source: source(), model, config: { ...config, tokenBudget: 1000 }, limit: 10 });
    expect(result).toMatchObject({ status: 'token_budget', turns: 2 });
  });

  it.each([
    ['refusal', 'refusal'],
    ['max_tokens', 'truncated'],
  ])('reports a %s stop and runs none of its tool calls', async (stopReason, status) => {
    const model = new ScriptedModel([turn('', [['record_triage', triage(1)]], stopReason)]);
    const result = await runTriage({ source: source(), model, config, limit: 10 });
    expect(result).toMatchObject({ status, toolCalls: 0, missing: [2, 1] });
  });

  it('keeps what was recorded before a limit, and calls a fully recorded run completed', async () => {
    const model = new ScriptedModel([
      turn('', [
        ['record_triage', triage(1)],
        ['record_triage', triage(2)],
      ]),
    ]);
    const result = await runTriage({ source: source(), model, config: { ...config, maxTurns: 1 }, limit: 10 });
    expect(result.status).toBe('completed');
    expect(result.triage).toHaveLength(2);
  });

  it('makes no model request when there are no open issues', async () => {
    const model = new ScriptedModel([]);
    const result = await runTriage({ source: source([]), model, config, limit: 10 });
    expect(result).toMatchObject({ status: 'completed', turns: 0, triage: [] });
  });

  it('respects the issue limit', async () => {
    const model = new ScriptedModel([turn('', [['record_triage', triage(2)]]), turn('Done.')]);
    const result = await runTriage({ source: source(), model, config, limit: 1 });
    expect(result.targets.map((i) => i.number)).toEqual([2]); // newest first
    expect(result.status).toBe('completed');
  });
});
