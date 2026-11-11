import { z } from 'zod';
import { CONFIDENCES, ISSUE_TYPES, PRIORITIES, type Issue, type IssueSource, type Triage } from './types.js';

/** Longest issue body handed to the model. Longer bodies are cut and flagged as truncated. */
export const MAX_BODY_CHARS = 8000;
const EXCERPT_CHARS = 280;
const SEARCH_LIMIT = 8;

export interface ToolContext {
  source: IssueSource;
  /** Canonical label names, keyed by lower-case name. */
  labels: Map<string, string>;
  /** The open issues this run is responsible for. */
  targets: Map<number, Issue>;
  records: Map<number, Triage>;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

/** JSON Schema as sent to the API. Every tool is strict, so inputs always match it. */
export interface ToolSpec {
  name: string;
  description: string;
  strict: true;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}…` : flat;
}

function brief(issue: Issue) {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    labels: issue.labels,
    author: issue.author,
    updated: issue.updatedAt.slice(0, 10),
    comments: issue.comments,
    excerpt: excerpt(issue.body),
  };
}

const ok = (value: unknown): ToolOutcome => ({ content: JSON.stringify(value), isError: false });
const fail = (message: string): ToolOutcome => ({ content: message, isError: true });

const GetIssueInput = z.object({ number: z.number().int().positive() });
const SearchInput = z.object({ query: z.string().min(1).max(200) });
const TriageInput = z.object({
  issue_number: z.number().int().positive(),
  type: z.enum(ISSUE_TYPES),
  priority: z.enum(PRIORITIES),
  labels: z.array(z.string()).max(8),
  duplicate_of: z.number().int().positive().nullable(),
  needs_info: z.boolean(),
  questions: z.array(z.string().max(300)).max(5),
  summary: z.string().min(1).max(400),
  rationale: z.string().min(1).max(800),
  confidence: z.enum(CONFIDENCES),
});

interface ToolDef {
  spec: ToolSpec;
  run(input: unknown, ctx: ToolContext): Promise<ToolOutcome>;
}

function invalid(error: z.ZodError): ToolOutcome {
  return fail(`Invalid input: ${error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`);
}

const listIssues: ToolDef = {
  spec: {
    name: 'list_issues',
    description:
      'List the open issues you are responsible for triaging in this run, newest activity first. Returns number, title, current labels, author and a short excerpt of each body. Call this first.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  async run(_input, ctx) {
    return ok({ repo: ctx.source.repo, count: ctx.targets.size, issues: [...ctx.targets.values()].map(brief) });
  },
};

const getIssue: ToolDef = {
  spec: {
    name: 'get_issue',
    description:
      'Read one issue in full (open or closed), including its complete body. Use it before triaging an issue and to check a suspected duplicate.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { number: { type: 'integer', description: 'Issue number' } },
      required: ['number'],
      additionalProperties: false,
    },
  },
  async run(input, ctx) {
    const parsed = GetIssueInput.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    const issue = ctx.targets.get(parsed.data.number) ?? (await ctx.source.getIssue(parsed.data.number));
    if (!issue) return fail(`Issue #${parsed.data.number} does not exist in ${ctx.source.repo}.`);
    const truncated = issue.body.length > MAX_BODY_CHARS;
    return ok({
      ...brief(issue),
      excerpt: undefined,
      created: issue.createdAt.slice(0, 10),
      body: truncated ? issue.body.slice(0, MAX_BODY_CHARS) : issue.body,
      body_truncated: truncated,
      ...(truncated ? { body_total_chars: issue.body.length } : {}),
    });
  },
};

const searchIssues: ToolDef = {
  spec: {
    name: 'search_issues',
    description: `Search this repository's issues, open and closed, by keywords. Use it to find duplicates and earlier reports of the same problem. Returns up to ${SEARCH_LIMIT} matches.`,
    strict: true,
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A few keywords, e.g. "empty config crash"' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  async run(input, ctx) {
    const parsed = SearchInput.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    const results = await ctx.source.search(parsed.data.query, SEARCH_LIMIT);
    return ok({ query: parsed.data.query, count: results.length, issues: results.map(brief) });
  },
};

const recordTriage: ToolDef = {
  spec: {
    name: 'record_triage',
    description:
      'Record your triage decision for one issue from list_issues. This writes to the local report only; nothing is posted to GitHub. Call it once per issue; calling it again for the same issue replaces the earlier record. The call is rejected, with the reason, if a label is not one of the repository labels or duplicate_of is not a real, different issue.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        issue_number: { type: 'integer' },
        type: { type: 'string', enum: [...ISSUE_TYPES] },
        priority: {
          type: 'string',
          enum: [...PRIORITIES],
          description: 'P0 = data loss, security hole or outage; P1 = serious bug with no workaround; P2 = normal; P3 = minor or cosmetic.',
        },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels the issue should have, chosen from the repository labels.' },
        duplicate_of: {
          anyOf: [{ type: 'integer' }, { type: 'null' }],
          description: 'Number of the older issue that this one duplicates, or null.',
        },
        needs_info: { type: 'boolean', description: 'True when a maintainer cannot act without more information from the reporter.' },
        questions: { type: 'array', items: { type: 'string' }, description: 'Questions for the reporter. Required when needs_info is true.' },
        summary: { type: 'string', description: 'One or two sentences on what the issue is about.' },
        rationale: { type: 'string', description: 'Why you chose this type and priority, for the maintainer who reviews the report.' },
        confidence: { type: 'string', enum: [...CONFIDENCES] },
      },
      required: ['issue_number', 'type', 'priority', 'labels', 'duplicate_of', 'needs_info', 'questions', 'summary', 'rationale', 'confidence'],
      additionalProperties: false,
    },
  },
  async run(input, ctx) {
    const parsed = TriageInput.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    const t = parsed.data;

    if (!ctx.targets.has(t.issue_number)) {
      return fail(`Issue #${t.issue_number} is not in this run. Record only issues returned by list_issues.`);
    }

    const labels: string[] = [];
    const unknown: string[] = [];
    for (const raw of t.labels) {
      const canonical = ctx.labels.get(raw.trim().toLowerCase());
      if (!canonical) unknown.push(raw);
      else if (!labels.includes(canonical)) labels.push(canonical);
    }
    if (unknown.length > 0) {
      return fail(`Unknown label(s): ${unknown.join(', ')}. Repository labels: ${[...ctx.labels.values()].join(', ')}.`);
    }

    if (t.duplicate_of !== null) {
      if (t.duplicate_of === t.issue_number) return fail('duplicate_of cannot be the issue itself.');
      const other = ctx.targets.get(t.duplicate_of) ?? (await ctx.source.getIssue(t.duplicate_of));
      if (!other) return fail(`duplicate_of #${t.duplicate_of} does not exist in ${ctx.source.repo}.`);
      const back = ctx.records.get(t.duplicate_of);
      if (back?.duplicate_of === t.issue_number) {
        return fail(`#${t.duplicate_of} is already recorded as a duplicate of #${t.issue_number}. Only the newer issue should point at the older one.`);
      }
    }

    if (t.needs_info && t.questions.length === 0) {
      return fail('needs_info is true, so questions must contain at least one question for the reporter.');
    }

    const replaced = ctx.records.has(t.issue_number);
    ctx.records.set(t.issue_number, { ...t, labels });
    const remaining = [...ctx.targets.keys()].filter((n) => !ctx.records.has(n));
    return ok({ recorded: t.issue_number, replaced, remaining });
  },
};

const TOOLS: readonly ToolDef[] = [listIssues, getIssue, searchIssues, recordTriage];
const BY_NAME = new Map(TOOLS.map((t) => [t.spec.name, t]));

export const toolSpecs: ToolSpec[] = TOOLS.map((t) => t.spec);

/** Runs one tool call. Unknown tools and thrown errors come back as error results, never as exceptions. */
export async function executeTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const tool = BY_NAME.get(name);
  if (!tool) return fail(`Unknown tool "${name}". Available tools: ${[...BY_NAME.keys()].join(', ')}.`);
  try {
    return await tool.run(input, ctx);
  } catch (err) {
    return fail(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
