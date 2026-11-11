import type { RunResult, Triage } from './types.js';

/** What a correct triage of one fixture issue looks like. Lists mean "any of these is acceptable". */
export interface Expected {
  type: Triage['type'][];
  priority: Triage['priority'][];
  duplicate_of: number | null;
  needs_info: boolean;
}

export type ExpectedSet = Record<string, Expected>;

export const CHECKS = ['type', 'priority', 'duplicate', 'needs_info'] as const;
export type Check = (typeof CHECKS)[number];

export interface IssueScore {
  issue: number;
  /** null when the agent recorded nothing for the issue; every check then fails. */
  got: Triage | null;
  expected: Expected;
  passed: Record<Check, boolean>;
}

export interface EvalScore {
  issues: IssueScore[];
  /** Share of issues that passed each check, 0 to 1. */
  accuracy: Record<Check, number>;
  /** Share of issues that passed all four checks. */
  allCorrect: number;
}

function scoreIssue(issue: number, expected: Expected, got: Triage | null): IssueScore {
  return {
    issue,
    got,
    expected,
    passed: {
      type: got !== null && expected.type.includes(got.type),
      priority: got !== null && expected.priority.includes(got.priority),
      duplicate: got !== null && got.duplicate_of === expected.duplicate_of,
      needs_info: got !== null && got.needs_info === expected.needs_info,
    },
  };
}

/** Compares a run with the labeled expectations. Issues without a label are ignored. */
export function scoreRun(result: RunResult, expected: ExpectedSet): EvalScore {
  const byNumber = new Map(result.triage.map((t) => [t.issue_number, t]));
  const issues = Object.entries(expected)
    .map(([number, exp]) => scoreIssue(Number(number), exp, byNumber.get(Number(number)) ?? null))
    .sort((a, b) => a.issue - b.issue);
  const share = (pass: (s: IssueScore) => boolean): number => (issues.length ? issues.filter(pass).length / issues.length : 0);
  return {
    issues,
    accuracy: {
      type: share((s) => s.passed.type),
      priority: share((s) => s.passed.priority),
      duplicate: share((s) => s.passed.duplicate),
      needs_info: share((s) => s.passed.needs_info),
    },
    allCorrect: share((s) => CHECKS.every((c) => s.passed[c])),
  };
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;
const mark = (ok: boolean): string => (ok ? '✅' : '❌');

export function renderEval(score: EvalScore, result: RunResult): string {
  const lines = [
    `# Eval: ${result.repo}`,
    '',
    `Model \`${result.model}\`, ${score.issues.length} labeled issues, run status \`${result.status}\`.`,
    '',
    '| Type | Priority | Duplicate | Needs info | All four correct |',
    '|---|---|---|---|---|',
    `| ${pct(score.accuracy.type)} | ${pct(score.accuracy.priority)} | ${pct(score.accuracy.duplicate)} | ${pct(score.accuracy.needs_info)} | ${pct(score.allCorrect)} |`,
    '',
    '| Issue | Type | Priority | Duplicate of | Needs info |',
    '|---|---|---|---|---|',
  ];
  for (const s of score.issues) {
    const g = s.got;
    lines.push(
      g
        ? `| #${s.issue} | ${mark(s.passed.type)} ${g.type} | ${mark(s.passed.priority)} ${g.priority} | ${mark(s.passed.duplicate)} ${g.duplicate_of ? `#${g.duplicate_of}` : 'none'} | ${mark(s.passed.needs_info)} ${g.needs_info ? 'yes' : 'no'} |`
        : `| #${s.issue} | ❌ not triaged | ❌ | ❌ | ❌ |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
