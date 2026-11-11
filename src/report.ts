import { totalTokens } from './agent.js';
import type { Issue, RunResult, Triage } from './types.js';

const STATUS_TEXT: Record<RunResult['status'], string> = {
  completed: 'Completed: every issue has a triage record.',
  incomplete: 'Incomplete: the model stopped early.',
  max_turns: 'Incomplete: the model-request limit was reached.',
  max_tool_calls: 'Incomplete: the tool-call limit was reached.',
  token_budget: 'Incomplete: the token budget was used up.',
  refusal: 'Incomplete: the model declined to continue.',
  truncated: 'Incomplete: a model response was cut off.',
};

/** Escapes text that goes into a markdown table cell. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

/** Labels to add and to remove, compared with what the issue has now. */
export function labelChanges(issue: Issue, triage: Triage): { add: string[]; remove: string[] } {
  const current = new Set(issue.labels.map((l) => l.toLowerCase()));
  const wanted = new Set(triage.labels.map((l) => l.toLowerCase()));
  return {
    add: triage.labels.filter((l) => !current.has(l.toLowerCase())),
    remove: issue.labels.filter((l) => !wanted.has(l.toLowerCase())),
  };
}

function issueSection(issue: Issue, t: Triage): string[] {
  const { add, remove } = labelChanges(issue, t);
  const lines = [
    `### #${issue.number} ${issue.title}`,
    '',
    `**${t.type}**, **${t.priority}**, confidence ${t.confidence}${t.duplicate_of ? `, duplicate of #${t.duplicate_of}` : ''}`,
    '',
    t.summary,
    '',
    `- Why: ${t.rationale}`,
    `- Labels: ${t.labels.length ? t.labels.map((l) => `\`${l}\``).join(', ') : 'none'}` +
      `${add.length ? ` (add ${add.map((l) => `\`${l}\``).join(', ')})` : ''}` +
      `${remove.length ? ` (remove ${remove.map((l) => `\`${l}\``).join(', ')})` : ''}`,
  ];
  if (t.needs_info) {
    lines.push('- Questions for the reporter:');
    for (const q of t.questions) lines.push(`  - ${q}`);
  }
  lines.push('');
  return lines;
}

/** The report a maintainer reads. Nothing in it has been applied to the repository. */
export function renderReport(result: RunResult): string {
  const byNumber = new Map(result.triage.map((t) => [t.issue_number, t]));
  const u = result.usage;
  const lines = [
    `# Issue triage: ${result.repo}`,
    '',
    `${STATUS_TEXT[result.status]}${result.detail ? ` ${result.detail}` : ''}`,
    '',
    `${result.triage.length} of ${result.targets.length} open issues triaged by \`${result.model}\`. These are suggestions; nothing was changed on GitHub.`,
    '',
  ];
  if (result.finalText) lines.push(result.finalText, '');

  if (result.triage.length > 0) {
    lines.push('| Issue | Title | Type | Priority | Duplicate of | Needs info | Confidence |', '|---|---|---|---|---|---|---|');
    for (const issue of result.targets) {
      const t = byNumber.get(issue.number);
      if (!t) continue;
      lines.push(
        `| #${issue.number} | ${cell(issue.title)} | ${t.type} | ${t.priority} | ${t.duplicate_of ? `#${t.duplicate_of}` : ''} | ${t.needs_info ? 'yes' : ''} | ${t.confidence} |`,
      );
    }
    lines.push('');
  }
  if (result.missing.length > 0) lines.push(`Not triaged: ${result.missing.map((n) => `#${n}`).join(', ')}.`, '');

  lines.push('## Details', '');
  for (const issue of result.targets) {
    const t = byNumber.get(issue.number);
    if (t) lines.push(...issueSection(issue, t));
  }

  lines.push(
    '## Run',
    '',
    `- Model requests: ${result.turns}`,
    `- Tool calls: ${result.toolCalls} (${result.rejectedToolCalls} rejected and corrected)`,
    `- Tokens: ${totalTokens(u).toLocaleString('en-US')} (input ${u.inputTokens.toLocaleString('en-US')}, cache read ${u.cacheReadTokens.toLocaleString('en-US')}, cache write ${u.cacheCreationTokens.toLocaleString('en-US')}, output ${u.outputTokens.toLocaleString('en-US')})`,
    `- Time: ${(result.durationMs / 1000).toFixed(1)}s`,
    '',
  );
  return lines.join('\n');
}
