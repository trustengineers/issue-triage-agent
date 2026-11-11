import { readFileSync } from 'node:fs';
import type { Issue, IssueSource, Label } from './types.js';

export interface Fixture {
  repo: string;
  labels: Label[];
  issues: Issue[];
}

const STOP_WORDS = new Set(
  'a an and are as at be but by for from has have how i if in is it its my not of on or so that the this to was when with you'.split(' '),
);

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/** Issues loaded from a JSON file. Used by the tests, the eval and offline demos. */
export class FixtureSource implements IssueSource {
  readonly repo: string;
  constructor(private readonly fixture: Fixture) {
    this.repo = fixture.repo;
  }

  static fromFile(path: string): FixtureSource {
    return new FixtureSource(JSON.parse(readFileSync(path, 'utf8')) as Fixture);
  }

  async listLabels(): Promise<Label[]> {
    return this.fixture.labels;
  }

  async listOpenIssues(limit: number): Promise<Issue[]> {
    return this.fixture.issues
      .filter((i) => i.state === 'open')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async getIssue(number: number): Promise<Issue | null> {
    return this.fixture.issues.find((i) => i.number === number) ?? null;
  }

  /** Keyword search over titles and bodies; title hits count double. */
  async search(query: string, limit: number): Promise<Issue[]> {
    const q = [...new Set(terms(query))];
    if (q.length === 0) return [];
    return this.fixture.issues
      .map((issue) => {
        const title = new Set(terms(issue.title));
        const body = new Set(terms(issue.body));
        let score = 0;
        for (const t of q) score += (title.has(t) ? 2 : 0) + (body.has(t) ? 1 : 0);
        return { issue, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.issue.number - b.issue.number)
      .slice(0, limit)
      .map((s) => s.issue);
  }
}

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: Array<string | { name?: string }>;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
  comments: number;
  pull_request?: unknown;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** GitHub REST API, GET requests only. A token is optional for public repositories. */
export class GitHubSource implements IssueSource {
  constructor(
    readonly repo: string,
    private readonly token?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!REPO_RE.test(repo)) throw new Error(`repo must look like "owner/name", got "${repo}"`);
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`https://api.github.com${path}`, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'issue-triage-agent',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
    });
    if (!res.ok) {
      const text = await res.text();
      let message = text.slice(0, 200);
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? message;
      } catch {
        /* keep raw text */
      }
      throw new GitHubError(res.status, `GitHub ${res.status} for ${path}: ${message}`);
    }
    return (await res.json()) as T;
  }

  private static toIssue(g: GhIssue): Issue {
    return {
      number: g.number,
      title: g.title,
      body: g.body ?? '',
      state: g.state === 'closed' ? 'closed' : 'open',
      labels: g.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
      author: g.user?.login ?? 'unknown',
      createdAt: g.created_at,
      updatedAt: g.updated_at,
      comments: g.comments,
    };
  }

  async listLabels(): Promise<Label[]> {
    const labels = await this.get<Array<{ name: string; description: string | null }>>(`/repos/${this.repo}/labels?per_page=100`);
    return labels.map((l) => ({ name: l.name, ...(l.description ? { description: l.description } : {}) }));
  }

  async listOpenIssues(limit: number): Promise<Issue[]> {
    // The issues endpoint also returns pull requests, so ask for extra and filter.
    const perPage = Math.min(100, Math.max(limit * 2, 20));
    const items = await this.get<GhIssue[]>(`/repos/${this.repo}/issues?state=open&sort=updated&direction=desc&per_page=${perPage}`);
    return items
      .filter((i) => !i.pull_request)
      .slice(0, limit)
      .map(GitHubSource.toIssue);
  }

  async getIssue(number: number): Promise<Issue | null> {
    try {
      const g = await this.get<GhIssue>(`/repos/${this.repo}/issues/${number}`);
      return g.pull_request ? null : GitHubSource.toIssue(g);
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 404 || err.status === 410)) return null;
      throw err;
    }
  }

  async search(query: string, limit: number): Promise<Issue[]> {
    const q = encodeURIComponent(`repo:${this.repo} is:issue ${query}`);
    const res = await this.get<{ items: GhIssue[] }>(`/search/issues?q=${q}&per_page=${Math.min(limit, 30)}`);
    return res.items.map(GitHubSource.toIssue);
  }
}
