import { describe, expect, it } from 'vitest';
import { executeTool, MAX_BODY_CHARS, toolSpecs, type ToolContext } from '../src/tools.js';
import type { Issue } from '../src/types.js';
import { issue, source, triage } from './helpers.js';

async function context(issues?: Issue[]): Promise<ToolContext> {
  const src = source(issues);
  const open = await src.listOpenIssues(50);
  const labels = await src.listLabels();
  return {
    source: src,
    labels: new Map(labels.map((l) => [l.name.toLowerCase(), l.name])),
    targets: new Map(open.map((i) => [i.number, i])),
    records: new Map(),
  };
}

describe('tool specs', () => {
  it('are strict and closed', () => {
    expect(toolSpecs.map((t) => t.name)).toEqual(['list_issues', 'get_issue', 'search_issues', 'record_triage']);
    for (const spec of toolSpecs) {
      expect(spec.strict).toBe(true);
      expect(spec.input_schema.additionalProperties).toBe(false);
      expect(spec.input_schema.required.sort()).toEqual(Object.keys(spec.input_schema.properties).sort());
    }
  });
});

describe('read tools', () => {
  it('list_issues returns the open issues of the run with excerpts', async () => {
    const ctx = await context([issue(1, 'Open one', 'x'.repeat(500)), issue(2, 'Closed one', '', { state: 'closed' })]);
    const out = JSON.parse((await executeTool('list_issues', {}, ctx)).content);
    expect(out.count).toBe(1);
    expect(out.issues[0].number).toBe(1);
    expect(out.issues[0].excerpt.length).toBeLessThan(300);
  });

  it('get_issue reads closed issues too and cuts very long bodies', async () => {
    const ctx = await context([issue(1, 'Long', 'y'.repeat(MAX_BODY_CHARS + 50)), issue(2, 'Old', 'done', { state: 'closed' })]);
    const long = JSON.parse((await executeTool('get_issue', { number: 1 }, ctx)).content);
    expect(long.body).toHaveLength(MAX_BODY_CHARS);
    expect(long.body_truncated).toBe(true);
    expect(long.body_total_chars).toBe(MAX_BODY_CHARS + 50);
    const closed = JSON.parse((await executeTool('get_issue', { number: 2 }, ctx)).content);
    expect(closed).toMatchObject({ state: 'closed', body: 'done', body_truncated: false });
  });

  it('get_issue reports a missing issue and bad input as errors', async () => {
    const ctx = await context();
    expect(await executeTool('get_issue', { number: 999 }, ctx)).toMatchObject({ isError: true, content: expect.stringContaining('does not exist') });
    expect(await executeTool('get_issue', { number: 'one' }, ctx)).toMatchObject({ isError: true, content: expect.stringContaining('Invalid input') });
  });

  it('search_issues finds issues by keyword, title matches first', async () => {
    const ctx = await context([issue(1, 'Unrelated', 'mentions config once'), issue(2, 'Crash on empty config'), issue(3, 'Docs typo')]);
    const out = JSON.parse((await executeTool('search_issues', { query: 'empty config crash' }, ctx)).content);
    expect(out.issues.map((i: Issue) => i.number)).toEqual([2, 1]);
  });
});

describe('record_triage', () => {
  it('stores a record, canonicalizes label case and reports what is left', async () => {
    const ctx = await context();
    const out = await executeTool('record_triage', triage(1, { labels: ['BUG', 'needs-info', 'bug'] }), ctx);
    expect(JSON.parse(out.content)).toEqual({ recorded: 1, replaced: false, remaining: [2] });
    expect(ctx.records.get(1)!.labels).toEqual(['bug', 'Needs-Info']);
  });

  it('replaces an earlier record for the same issue', async () => {
    const ctx = await context();
    await executeTool('record_triage', triage(1), ctx);
    const out = await executeTool('record_triage', triage(1, { priority: 'P0' }), ctx);
    expect(JSON.parse(out.content).replaced).toBe(true);
    expect(ctx.records.get(1)!.priority).toBe('P0');
  });

  it.each([
    ['an issue outside the run', triage(42), 'not in this run'],
    ['an unknown label', triage(1, { labels: ['bug', 'critical'] }), 'Unknown label(s): critical'],
    ['a duplicate of itself', triage(1, { duplicate_of: 1 }), 'cannot be the issue itself'],
    ['a duplicate that does not exist', triage(1, { duplicate_of: 77 }), '#77 does not exist'],
    ['needs_info without questions', triage(1, { needs_info: true }), 'questions must contain'],
    ['a value outside the enum', { ...triage(1), priority: 'urgent' }, 'Invalid input: priority'],
    ['a missing field', { issue_number: 1 }, 'Invalid input'],
  ])('rejects %s', async (_name, input, message) => {
    const ctx = await context();
    const out = await executeTool('record_triage', input, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain(message);
    expect(ctx.records.size).toBe(0);
  });

  it('rejects two issues that point at each other as duplicates', async () => {
    const ctx = await context();
    expect((await executeTool('record_triage', triage(2, { duplicate_of: 1 }), ctx)).isError).toBe(false);
    const out = await executeTool('record_triage', triage(1, { duplicate_of: 2 }), ctx);
    expect(out).toMatchObject({ isError: true, content: expect.stringContaining('already recorded as a duplicate') });
  });
});

describe('executeTool', () => {
  it('turns unknown tools and thrown errors into error results', async () => {
    const ctx = await context();
    expect(await executeTool('close_issue', {}, ctx)).toMatchObject({ isError: true, content: expect.stringContaining('Unknown tool "close_issue"') });
    ctx.source = { ...ctx.source, repo: 'acme/demo', search: async () => Promise.reject(new Error('GitHub 403: rate limit')) } as ToolContext['source'];
    expect(await executeTool('search_issues', { query: 'x' }, ctx)).toEqual({ isError: true, content: 'search_issues failed: GitHub 403: rate limit' });
  });
});
