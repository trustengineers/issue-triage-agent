import { describe, expect, it } from 'vitest';
import { FixtureSource, GitHubSource } from '../src/source.js';

function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: Array<{ url: string; method?: string; auth?: string }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace('https://api.github.com', '');
    calls.push({ url: path, method: init?.method, auth: (init?.headers as Record<string, string>).authorization });
    const route = Object.entries(routes).find(([prefix]) => path.startsWith(prefix))?.[1] ?? { status: 404, body: { message: 'Not Found' } };
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

const gh = (number: number, extra: object = {}) => ({
  number,
  title: `Issue ${number}`,
  body: null,
  state: 'open',
  labels: [{ name: 'bug' }, 'windows'],
  user: { login: 'octo' },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  comments: 1,
  ...extra,
});

describe('GitHubSource', () => {
  it('rejects a malformed repository name', () => {
    expect(() => new GitHubSource('not a repo')).toThrow('owner/name');
    expect(() => new GitHubSource('owner/name/../../orgs')).toThrow('owner/name');
  });

  it('lists open issues without pull requests, using GET only', async () => {
    const { impl, calls } = fakeFetch({ '/repos/o/r/issues': { body: [gh(3), gh(2, { pull_request: {} }), gh(1)] } });
    const issues = await new GitHubSource('o/r', 'tok', impl).listOpenIssues(2);
    expect(issues.map((i) => i.number)).toEqual([3, 1]);
    expect(issues[0]).toMatchObject({ body: '', labels: ['bug', 'windows'], author: 'octo', updatedAt: '2026-01-02T00:00:00Z' });
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(calls[0]!.auth).toBe('Bearer tok');
  });

  it('sends no authorization header without a token', async () => {
    const { impl, calls } = fakeFetch({ '/repos/o/r/labels': { body: [{ name: 'bug', description: null }] } });
    expect(await new GitHubSource('o/r', undefined, impl).listLabels()).toEqual([{ name: 'bug' }]);
    expect(calls[0]!.auth).toBeUndefined();
  });

  it('returns null for a missing issue or a pull request, and throws on other errors', async () => {
    const { impl } = fakeFetch({
      '/repos/o/r/issues/7': { body: gh(7, { pull_request: {} }) },
      '/repos/o/r/issues/8': { status: 403, body: { message: 'API rate limit exceeded' } },
    });
    const src = new GitHubSource('o/r', undefined, impl);
    expect(await src.getIssue(5)).toBeNull();
    expect(await src.getIssue(7)).toBeNull();
    await expect(src.getIssue(8)).rejects.toThrow('GitHub 403 for /repos/o/r/issues/8: API rate limit exceeded');
  });

  it('scopes search to the repository', async () => {
    const { impl, calls } = fakeFetch({ '/search/issues': { body: { items: [gh(4, { state: 'closed' })] } } });
    const found = await new GitHubSource('o/r', undefined, impl).search('crash repo:evil/other', 5);
    expect(found[0]).toMatchObject({ number: 4, state: 'closed' });
    expect(decodeURIComponent(calls[0]!.url)).toContain('q=repo:o/r is:issue crash');
  });
});

describe('bundled fixture', () => {
  const src = FixtureSource.fromFile('fixtures/issues.json');

  it('has 12 open issues, each with an expected result', async () => {
    const open = await src.listOpenIssues(50);
    const expected = (await import('../fixtures/expected.json', { with: { type: 'json' } })).default as Record<string, unknown>;
    expect(open).toHaveLength(12);
    expect(Object.keys(expected).map(Number).sort()).toEqual(open.map((i) => i.number).sort());
  });

  it('search surfaces the older report of a duplicate', async () => {
    const found = await src.search("TypeError reading 'rules' empty config", 8);
    expect(found.map((i) => i.number)).toContain(101);
  });
});
