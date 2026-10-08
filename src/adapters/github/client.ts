import { createHash } from 'node:crypto';
import { descriptionHash } from '../../domain/identity.js';
import { passed } from '../../domain/test-evidence.js';
import { safePath } from '../../domain/snapshot.js';
import { issueDigest } from '../../domain/iteration.js';
import { feedbackDigest } from '../../domain/feedback.js';
import type { PullFeedback, PullOutcome, QueueIssue } from '../../ports/automation.js';
import type { Issue, PullRequest, Report } from '../../domain/types.js';
import type { GitHub as GitHubPort } from '../../ports/github.js';
import { markdownReport } from '../../reporting/markdown.js';
import { RetryableError, retry, type RetryOptions } from '../../shared/control.js';

export class GitHub implements GitHubPort {
  constructor(readonly repository: string, private token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
    private options: { signal?: AbortSignal; transport?: typeof fetch; retry?: RetryOptions } = {}) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid repository.');
  }
  async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    return this.api<T>(`repos/${this.repository}${path ? '/' + path : ''}`, method, body);
  }
  private async api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const operation = async () => {
      const timeout = AbortSignal.timeout(30000);
      const response = await (this.options.transport ?? fetch)(`https://api.github.com/${path}`, {
        method, signal: this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout, redirect: 'error',
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'RepoPilot/0.1',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
      }).catch(error => {
        this.options.signal?.throwIfAborted();
        if (error instanceof TypeError || timeout.aborted) throw new RetryableError('GitHub transport unavailable or timed out.');
        throw error;
      });
      if (!response.ok) {
        const message = `GitHub ${method} ${path}: HTTP ${response.status}`;
        if (response.status === 429 || response.status >= 500 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
          const header = response.headers.get('retry-after') ?? '0';
          const seconds = Number(header);
          const retryDelay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
          const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000 - Date.now();
          throw new RetryableError(message, Math.max(0, Number.isFinite(retryDelay) ? retryDelay : 0, Number.isFinite(reset) ? reset : 0));
        }
        throw new Error(message);
      }
      return await response.json() as T;
    };
    return method === 'GET' ? retry(operation, this.options.retry ?? { attempts: 3, baseDelayMs: 1000, maxDelayMs: 30000 }, this.options.signal) : operation();
  }
  async listPulls(): Promise<PullRequest[]> {
    const pulls: PullRequest[] = [];
    for (let page = 1; page <= 10; page++) {
      const items = await this.request<PullRequest[]>(`pulls?state=open&per_page=100&page=${page}`);
      pulls.push(...items); if (items.length < 100) return pulls;
    }
    throw new Error('Over 1,000 open PRs; narrow the MVP repository.');
  }
  pull(number: number): Promise<PullRequest> { return this.request(`pulls/${number}`); }
  private async pages<T>(path: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= 10; page++) {
      const items = await this.request<T[]>(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      all.push(...items); if (items.length < 100) return all;
    }
    throw new Error('GitHub collection exceeded 1,000 entries; refusing partial evidence.');
  }
  issues(state: 'open' | 'all'): Promise<QueueIssue[]> { return this.pages(`issues?state=${state}&sort=created&direction=asc`); }
  async syncProgress(number: number, marker: string, body: string): Promise<number> {
    if (!Number.isSafeInteger(number) || number < 1 || !/^<!-- repopilot-progress:[a-f0-9]{24} -->$/.test(marker)
      || !body.startsWith(marker + '\n') || body.length > 10000) throw new Error('Invalid progress message.');
    const actor = await this.api<{ login: string }>('user');
    if (!actor.login) throw new Error('Progress feedback requires a GitHub user token.');
    const comments = await this.pages<{ id: number; body: string; user: { login: string } }>(`issues/${number}/comments`);
    const owned = comments.filter(item => item.user.login === actor.login && item.body.startsWith(marker + '\n'))
      .sort((a, b) => a.id - b.id)[0];
    // A timed-out creation is recovered by reading the author's marker on the next attempt.
    if (owned) {
      if (owned.body !== body) await this.request(`issues/comments/${owned.id}`, 'PATCH', { body });
      return owned.id;
    }
    return (await this.request<{ id: number }>(`issues/${number}/comments`, 'POST', { body })).id;
  }
  private async checks(sha: string): Promise<PullFeedback['checks']> {
    const checks: PullFeedback['checks'] = [];
    for (let page = 1; ; page++) {
      const result = await this.request<{ total_count: number; check_runs: PullFeedback['checks'] }>(`commits/${sha}/check-runs?per_page=100&page=${page}`);
      checks.push(...result.check_runs.map(c => ({ name: c.name, status: c.status, conclusion: c.conclusion })));
      if (checks.length >= result.total_count) break;
      if (page >= 10 || !result.check_runs.length) throw new Error('Incomplete check-run evidence.');
    }
    const statuses = await this.pages<{ context: string; state: string }>(`commits/${sha}/statuses`);
    const contexts = new Set<string>();
    for (const status of statuses) if (!contexts.has(status.context)) {
      contexts.add(status.context); checks.push({ name: status.context, status: status.state === 'pending' ? 'in_progress' : 'completed', conclusion: status.state });
    }
    return checks;
  }
  async feedback(number: number): Promise<PullFeedback> {
    const pr = await this.pull(number);
    const comments = await this.pages<{ id: number; user: { login: string }; body: string }>(`issues/${number}/comments`);
    const reviews = await this.pages<{ id: number; user: { login: string }; body: string; commit_id: string; state: string }>(`pulls/${number}/reviews`);
    const inline = await this.pages<{ id: number; user: { login: string }; body: string; commit_id: string }>(`pulls/${number}/comments`);
    const checks = await this.checks(pr.head.sha);
    const headCommit = await this.request<{ message: string }>(`git/commits/${pr.head.sha}`);
    const headRun = headCommit.message.match(/^RepoPilot-Run: ([a-f0-9]{24})$/m)?.[1];
    return { pr, headRun, checks, comments: [
      ...comments.filter(c => !c.body.startsWith('<!-- repopilot-progress:')).map(c => ({ id: 'comment-' + c.id, author: c.user.login, body: c.body })),
      ...reviews.filter(r => r.state !== 'DISMISSED' && r.state !== 'PENDING').map(c => ({ id: 'review-' + c.id, author: c.user.login, body: c.body, commit: c.commit_id })),
      ...inline.map(c => ({ id: 'inline-' + c.id, author: c.user.login, body: c.body, commit: c.commit_id }))
    ] };
  }
  async outcome(number: number): Promise<PullOutcome> {
    const pr = await this.request<PullOutcome['pr']>(`pulls/${number}`);
    const sha = pr.merge_commit_sha ?? pr.head.sha;
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Pull request outcome has no valid commit.');
    return { pr, checks: await this.checks(sha) };
  }
  async propose(title: string, body: string): Promise<string> {
    if (!this.token) throw new Error('GitHub token required.');
    return (await this.request<{ html_url: string }>('issues', 'POST', { title, body })).html_url;
  }
  async updatePull(report: Report, number: number, expectedHead: string, expectedBase: string, digest: string, signal?: AbortSignal): Promise<{ url: string; head: string } | undefined> {
    if (signal) return new GitHub(this.repository, this.token, { ...this.options, signal: this.options.signal ? AbortSignal.any([signal, this.options.signal]) : signal }).updatePull(report, number, expectedHead, expectedBase, digest);
    if (!this.token || report.repository !== this.repository || report.status !== 'verified' || !report.tests.repaired || !passed(report.tests.repaired) || !report.changes.length) throw new Error('Only independently verified follow-ups can update a PR.');
    const current = await this.feedback(number), pr = current.pr;
    if (pr.state !== 'open' || pr.head.repo?.full_name !== this.repository || pr.base.repo.full_name !== this.repository || !/^autofix\/goal-[a-f0-9]{24}\/[a-f0-9]{24}$/.test(pr.head.ref) || pr.head.sha !== expectedHead || pr.base.sha !== expectedBase || feedbackDigest(current) !== digest) return undefined;
    const parent = await this.request<{ tree: { sha: string } }>(`git/commits/${expectedHead}`);
    const entries = await this.request<{ truncated: boolean; tree: { path: string; mode: string; type: string }[] }>(`git/trees/${parent.tree.sha}?recursive=1`);
    if (entries.truncated) throw new Error('Truncated PR tree.');
    const modes = new Map(entries.tree.filter(e => e.type === 'blob').map(e => [e.path, e.mode]));
    const seen = new Set<string>();
    for (const change of report.changes) {
      if (!safePath(change.path) || seen.has(change.path.toLowerCase()) || typeof change.content !== 'string'
        || (modes.has(change.path) && !['100644', '100755'].includes(modes.get(change.path)!))) throw new Error('Invalid follow-up path or file mode.');
      seen.add(change.path.toLowerCase());
    }
    const tree = await this.request<{ sha: string }>('git/trees', 'POST', { base_tree: parent.tree.sha,
      tree: report.changes.map(c => ({ path: c.path, mode: modes.get(c.path) ?? '100644', type: 'blob', content: c.content })) });
    const commit = await this.request<{ sha: string }>('git/commits', 'POST', {
      message: `fix: verified follow-up for #${number}\n\nRepoPilot-Run: ${report.id}`, tree: tree.sha,
      parents: expectedBase === expectedHead ? [expectedHead] : [expectedHead, expectedBase] });
    const latest = await this.feedback(number);
    if (feedbackDigest(latest) !== digest) return undefined;
    await this.request(`git/refs/heads/${encodeURIComponent(pr.head.ref)}`, 'PATCH', { sha: commit.sha, force: false });
    return { url: `https://github.com/${this.repository}/pull/${number}`, head: commit.sha };
  }
  /** Reconcile an interrupted publication only when the complete committed tree matches saved evidence. */
  async recoverPull(report: Report, number: number, branch: string): Promise<{ url: string; head: string } | undefined> {
    if (report.repository !== this.repository || !['verified', 'published'].includes(report.status)
      || !report.tests.repaired || !passed(report.tests.repaired) || !report.changes.length) return undefined;
    const pr = await this.pull(number);
    if (pr.state !== 'open' || pr.head.repo?.full_name !== this.repository || pr.base.repo.full_name !== this.repository
      || pr.head.ref !== branch || !/^autofix\/goal-[a-f0-9]{24}\/[a-f0-9]{24}$/.test(branch)) return undefined;
    type Commit = { message: string; tree: { sha: string }; parents: { sha: string }[] };
    type Tree = { truncated: boolean; tree: { path: string; mode: string; type: string; sha: string }[] };
    const commit = await this.request<Commit>(`git/commits/${pr.head.sha}`);
    const parents = report.head === report.base ? [report.head] : [report.head, report.base];
    if (!commit.message.split('\n').includes('RepoPilot-Run: ' + report.id)
      || JSON.stringify(commit.parents.map(p => p.sha)) !== JSON.stringify(parents)) return undefined;
    const original = await this.request<Commit>(`git/commits/${report.head}`);
    const before = await this.request<Tree>(`git/trees/${original.tree.sha}?recursive=1`);
    const after = await this.request<Tree>(`git/trees/${commit.tree.sha}?recursive=1`);
    if (before.truncated || after.truncated) return undefined;
    const expected = new Map(before.tree.filter(e => e.type !== 'tree').map(e => [e.path, { mode: e.mode, type: e.type, sha: e.sha }]));
    const seen = new Set<string>();
    for (const change of report.changes) {
      if (!safePath(change.path) || seen.has(change.path) || typeof change.content !== 'string') return undefined;
      seen.add(change.path);
      const mode = expected.get(change.path)?.mode ?? '100644';
      if (!['100644', '100755'].includes(mode)) return undefined;
      const bytes = Buffer.from(change.content);
      const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      expected.set(change.path, { mode, type: 'blob', sha });
    }
    const actual = after.tree.filter(e => e.type !== 'tree');
    if (actual.length !== expected.size || actual.some(e => {
      const value = expected.get(e.path); return !value || value.mode !== e.mode || value.type !== e.type || value.sha !== e.sha;
    })) return undefined;
    const latest = await this.pull(number);
    return latest.state === 'open' && latest.head.sha === pr.head.sha && latest.head.ref === branch
      && latest.base.ref === pr.base.ref && latest.head.repo?.full_name === this.repository
      ? { url: `https://github.com/${this.repository}/pull/${number}`, head: pr.head.sha } : undefined;
  }
  issue(number: number): Promise<Issue> { return this.request(`issues/${number}`); }
  async target(branch?: string): Promise<{ branch: string; sha: string }> {
    if (!branch) branch = (await this.request<{ default_branch: string }>('')).default_branch;
    if (!branch || branch.startsWith('-') || /[\x00-\x20~^:?*\[\\]/.test(branch) || branch.includes('..')) throw new Error('Invalid target branch.');
    const ref = await this.request<{ object: { sha: string; type: string } }>('git/ref/heads/' + encodeURIComponent(branch));
    if (ref.object.type !== 'commit' || !/^[a-f0-9]{40}$/.test(ref.object.sha)) throw new Error('Target must be a commit.');
    return { branch, sha: ref.object.sha };
  }
  async current(report: Report): Promise<PullRequest | Issue | undefined> {
    if (report.goal) {
      const target = await this.target(report.goal.branch);
      if (target.sha !== report.head || report.base !== report.head) return undefined;
      if (report.goal.issue) {
        const issue = await this.issue(report.goal.issue);
        if (report.goal.queue) {
          const queued = issue as QueueIssue;
          if (!report.goal.queue.trustedAuthors.includes(queued.user?.login ?? '') || !report.goal.queue.labels.every(l => queued.labels?.some(v => v.name === l))) return undefined;
        }
        return !issue.pull_request && issue.state === 'open' && issueDigest(issue) === report.goal.issueDigest ? issue : undefined;
      }
      return { number: 0, title: report.goal.title, body: '', state: 'open' };
    }
    if (report.issue) {
      const issue = await this.issue(report.issue.number), target = await this.target(report.issue.branch);
      if (issue.pull_request || issue.state !== 'open' || issue.title !== report.issue.title || (issue.body ?? '') !== report.issue.body
        || target.sha !== report.head || report.base !== report.head || descriptionHash(undefined, issue.title + '\n' + (issue.body ?? '')) !== report.descriptionHash) return undefined;
      return issue;
    }
    if (!report.pr) return undefined;
    const pr = await this.pull(report.pr);
    return pr.state === 'open' && !pr.draft && !pr.head.ref.startsWith('autofix/') && pr.head.repo?.full_name === this.repository
      && pr.head.sha === report.head && pr.base.sha === report.base && descriptionHash(pr) === report.descriptionHash ? pr : undefined;
  }
  async publish(report: Report, signal?: AbortSignal): Promise<string | undefined> {
    if (signal) return new GitHub(this.repository, this.token, { ...this.options,
      signal: this.options.signal ? AbortSignal.any([this.options.signal, signal]) : signal }).publish(report);
    if (!this.token) throw new Error('GITHUB_TOKEN is required to publish.');
    if (report.repository !== this.repository || report.status !== 'verified' || !report.changes.length
      || !report.tests.repaired || !passed(report.tests.repaired)) throw new Error('Only verified repairs can be published.');
    const pr = await this.current(report);
    if (!pr) return undefined;
    const targetBranch = report.goal?.branch ?? report.issue?.branch ?? ('head' in pr ? pr.head.ref : undefined);
    if (!targetBranch) throw new Error('Missing publication branch.');
    const sourceNumber = report.goal?.issue ?? report.issue?.number ?? report.pr;
    const branch = report.goal ? `autofix/goal-${report.goal.id}/${report.id}` : `autofix/${report.issue ? 'issue' : 'pr'}-${sourceNumber}/${report.id}`;
    const existing = await this.request<{ html_url: string; state: string; head: { sha: string } }[]>(`pulls?state=all&head=${encodeURIComponent(this.repository.split('/')[0] + ':' + branch)}&base=${encodeURIComponent(targetBranch)}`);
    // Git data objects can be retried without moving a ref or touching the source PR branch.
    const parent = await this.request<{ tree: { sha: string } }>(`git/commits/${report.head}`);
    const sourceTree = await this.request<{ truncated: boolean; tree: { path: string; mode: string; type: string }[] }>(`git/trees/${parent.tree.sha}?recursive=1`);
    if (sourceTree.truncated) throw new Error('Source tree is truncated; cannot preserve file modes.');
    const modes = new Map(sourceTree.tree.filter(e => e.type === 'blob').map(e => [e.path, e.mode]));
    for (const change of report.changes) if (modes.has(change.path) && !['100644', '100755'].includes(modes.get(change.path)!)) throw new Error('Unsupported file mode.');
    const tree = await this.request<{ sha: string }>('git/trees', 'POST', {
      base_tree: parent.tree.sha,
      tree: report.changes.map(c => ({ path: c.path, mode: modes.get(c.path) ?? '100644', type: 'blob', content: c.content }))
    });
    const commit = await this.request<{ sha: string }>('git/commits', 'POST', {
      message: `fix: RepoPilot verified ${report.goal ? 'goal ' + report.goal.id : 'repair for #' + sourceNumber}\n\nRepoPilot-Run: ${report.id}`,
      tree: tree.sha, parents: [report.head]
    });
    if (existing[0]) {
      const prior = await this.request<{ tree: { sha: string }; parents: { sha: string }[] }>(`git/commits/${existing[0].head.sha}`);
      if (existing[0].state !== 'open' || prior.tree.sha !== tree.sha || prior.parents.length !== 1 || prior.parents[0]?.sha !== report.head) throw new Error('Existing repair PR does not match verified evidence.');
      return await this.current(report) ? existing[0].html_url : undefined;
    }
    if (!await this.current(report)) return undefined;
    // An existing ref from a interrupted publish is reusable only with the expected tree and parent.
    let ref: { object: { sha: string } } | undefined;
    try { ref = await this.request(`git/ref/heads/${branch}`); }
    catch (error) { if (!String(error).endsWith('HTTP 404')) throw error; }
    if (ref) {
      const previous = await this.request<{ tree: { sha: string }; parents: { sha: string }[] }>(`git/commits/${ref.object.sha}`);
      if (previous.tree.sha !== tree.sha || previous.parents[0]?.sha !== report.head || previous.parents.length !== 1) {
        throw new Error('Repair branch collision: refusing to overwrite.');
      }
    } else await this.request('git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: commit.sha });
    if (!await this.current(report)) return undefined;
    const result = await this.request<{ html_url: string }>('pulls', 'POST', {
      title: report.goal ? `feat: ${report.goal.title}` : `fix: verified repair for #${sourceNumber}`, head: branch, base: targetBranch, draft: true,
      body: (report.goal?.issue || report.issue ? `Fixes #${report.goal?.issue ?? report.issue!.number}\n\n` : '') + markdownReport(report).slice(0, 59000)
    });
    return result.html_url;
  }
}
