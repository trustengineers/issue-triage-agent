import { describe, expect, it } from 'vitest';
import { renderEval, scoreRun, type ExpectedSet } from '../src/eval.js';
import { labelChanges, renderReport } from '../src/report.js';
import { loadConfig } from '../src/config.js';
import { parseCli } from '../src/run.js';
import type { RunResult } from '../src/types.js';
import { issue, triage } from './helpers.js';

const result: RunResult = {
  status: 'incomplete',
  detail: 'The model stopped before recording every issue.',
  repo: 'acme/demo',
  model: 'test-model',
  targets: [issue(1, 'Crash | on empty config', '', { labels: ['question'] }), issue(2, 'Same crash'), issue(3, 'Never triaged')],
  triage: [
    triage(1, { priority: 'P1', labels: ['bug'] }),
    triage(2, { duplicate_of: 1, needs_info: true, questions: ['Which version?'], confidence: 'low' }),
  ],
  missing: [3],
  finalText: 'Two of three done.',
  turns: 4,
  toolCalls: 9,
  rejectedToolCalls: 1,
  usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 5000, cacheCreationTokens: 500 },
  durationMs: 12340,
};

describe('renderReport', () => {
  const report = renderReport(result);

  it('states the outcome and what was not triaged', () => {
    expect(report).toContain('Incomplete: the model stopped early. The model stopped before recording every issue.');
    expect(report).toContain('2 of 3 open issues triaged by `test-model`');
    expect(report).toContain('Not triaged: #3.');
  });

  it('has one table row and one section per triaged issue', () => {
    expect(report).toContain('| #1 | Crash \\| on empty config | bug | P1 |  |  | high |');
    expect(report).toContain('| #2 | Same crash | bug | P2 | #1 | yes | low |');
    expect(report).toContain('- Labels: `bug` (add `bug`) (remove `question`)');
    expect(report).toContain('  - Which version?');
    expect(report).not.toContain('### #3');
  });

  it('reports run statistics', () => {
    expect(report).toContain('- Tool calls: 9 (1 rejected and corrected)');
    expect(report).toContain('- Tokens: 7,000 (input 1,200, cache read 5,000, cache write 500, output 300)');
    expect(report).toContain('- Time: 12.3s');
  });

  it('compares labels without regard to case', () => {
    expect(labelChanges(issue(1, 't', '', { labels: ['Bug', 'old'] }), triage(1, { labels: ['bug', 'new'] }))).toEqual({ add: ['new'], remove: ['old'] });
  });
});

describe('scoreRun', () => {
  const expected: ExpectedSet = {
    '1': { type: ['bug'], priority: ['P0', 'P1'], duplicate_of: null, needs_info: false },
    '2': { type: ['bug'], priority: ['P2'], duplicate_of: 1, needs_info: false },
    '3': { type: ['docs'], priority: ['P3'], duplicate_of: null, needs_info: false },
  };
  const score = scoreRun(result, expected);

  it('scores each check and counts an untriaged issue as wrong', () => {
    expect(score.issues.map((s) => s.passed)).toEqual([
      { type: true, priority: true, duplicate: true, needs_info: true },
      { type: true, priority: true, duplicate: true, needs_info: false },
      { type: false, priority: false, duplicate: false, needs_info: false },
    ]);
    expect(score.accuracy.type).toBeCloseTo(2 / 3);
    expect(score.accuracy.needs_info).toBeCloseTo(1 / 3);
    expect(score.allCorrect).toBeCloseTo(1 / 3);
  });

  it('renders a summary and a per-issue table', () => {
    const report = renderEval(score, result);
    expect(report).toContain('| 67% | 67% | 67% | 33% | 33% |');
    expect(report).toContain('| #2 | ✅ bug | ✅ P2 | ✅ #1 | ❌ yes |');
    expect(report).toContain('| #3 | ❌ not triaged |');
  });
});

describe('configuration', () => {
  it('has safe defaults and reads overrides', () => {
    expect(loadConfig({})).toEqual({ model: 'claude-fable-5-2', effort: 'medium', maxTurns: 40, maxToolCalls: 150, tokenBudget: 1_000_000, fallbacks: true });
    expect(loadConfig({ ANTHROPIC_MODEL: 'claude-haiku-5-5', TRIAGE_EFFORT: 'low', TRIAGE_MAX_TURNS: '5', TRIAGE_FALLBACKS: 'off' })).toMatchObject({
      model: 'claude-haiku-5-5',
      effort: 'low',
      maxTurns: 5,
      fallbacks: false,
    });
  });

  it('rejects bad values', () => {
    expect(() => loadConfig({ TRIAGE_EFFORT: 'extreme' })).toThrow('TRIAGE_EFFORT must be one of');
    expect(() => loadConfig({ TRIAGE_MAX_TURNS: '0' })).toThrow('TRIAGE_MAX_TURNS must be a positive integer');
  });

  it('parses command-line arguments', () => {
    expect(parseCli(['--repo', 'o/r', '--limit', '5'])).toEqual({ repo: 'o/r', limit: 5, out: 'out', quiet: false });
    expect(parseCli([], { fixture: 'fixtures/issues.json' })).toMatchObject({ fixture: 'fixtures/issues.json', limit: 10 });
    expect(() => parseCli([])).toThrow('Pass --repo');
    expect(() => parseCli(['--repo', 'o/r', '--fixture', 'f.json'])).toThrow('not both');
    expect(() => parseCli(['--repo', 'o/r', '--limit', '500'])).toThrow('--limit');
  });
});
