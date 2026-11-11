export interface Label {
  name: string;
  description?: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  author: string;
  createdAt: string;
  updatedAt: string;
  comments: number;
}

/** Read-only view of a repository's issues. Nothing in this interface can change the repo. */
export interface IssueSource {
  readonly repo: string;
  listLabels(): Promise<Label[]>;
  listOpenIssues(limit: number): Promise<Issue[]>;
  getIssue(number: number): Promise<Issue | null>;
  search(query: string, limit: number): Promise<Issue[]>;
}

export const ISSUE_TYPES = ['bug', 'feature', 'question', 'docs', 'chore', 'invalid'] as const;
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export const CONFIDENCES = ['low', 'medium', 'high'] as const;

export interface Triage {
  issue_number: number;
  type: (typeof ISSUE_TYPES)[number];
  priority: (typeof PRIORITIES)[number];
  labels: string[];
  duplicate_of: number | null;
  needs_info: boolean;
  questions: string[];
  summary: string;
  rationale: string;
  confidence: (typeof CONFIDENCES)[number];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export type StopStatus = 'completed' | 'incomplete' | 'max_turns' | 'max_tool_calls' | 'token_budget' | 'refusal' | 'truncated';

export interface RunResult {
  status: StopStatus;
  detail?: string;
  repo: string;
  model: string;
  targets: Issue[];
  triage: Triage[];
  missing: number[];
  finalText: string;
  turns: number;
  toolCalls: number;
  rejectedToolCalls: number;
  usage: Usage;
  durationMs: number;
}
