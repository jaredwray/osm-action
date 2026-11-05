import test from 'node:test';
import assert from 'node:assert/strict';
import { code, dashboardBody, flagBody, IssueSync, issueSkipReason, LABEL } from '../src/issues.ts';
import { Http } from '../src/http.ts';
import type { Fetch } from '../src/http.ts';
import type { Asset, Report, Verdict } from '../src/model.ts';
const A = 'a'.repeat(40), B = 'b'.repeat(40), ROOT = `owner/repo@${'c'.repeat(40)}`;
const ctx = { repository: 'owner/repo', runUrl: 'https://github.com/owner/repo/actions/runs/1' };
const loc = (file: string, line: number, source = ROOT) => ({ source, file, line, chain: [`${source}:${file}`] });
const asset = (repository: string, requestedRef: string, resolvedSha: string | undefined, path = '', locations = [loc('.github/workflows/ci.yml', 7)]): Asset =>
  ({ repository, path, requestedRef, ...(resolvedSha ? { resolvedSha } : {}), locations });
const verdict = (repository: string, state: Verdict['state'], reportUrl?: string): Verdict =>
  ({ repository, state, checkedAt: '', ...(reportUrl ? { reportUrl } : {}) });
function report(assets: Asset[], verdicts: Verdict[], extra: Partial<Report> = {}): Report {
  return { schemaVersion: 1, scannerVersion: '0.1.0', startedAt: '', finishedAt: '2026-11-05T00:00:00Z', target: ROOT,
    scope: 'github-repository-intelligence', result: verdicts.some(v => v.state === 'flagged-repository') ? 'fail' : 'pass',
    complete: true, assets, verdicts, findings: [], files: [],
    coverage: { checkedRepositories: verdicts.length, unresolved: 0, gaps: 0, exclusions: [] }, ...extra };
}
const OSM = 'https://opensourcemalware.com/repository/https%3A%2F%2Fgithub.com%2Fbad%2Faction';
const flaggedReport = () => report([asset('bad/action', A, A), asset('actions/checkout', 'v4', B)],
  [verdict('actions/checkout', 'no-verified-match'), verdict('bad/action', 'flagged-repository', OSM)]);
/** Removes code spans and link targets so assertions can check what GitHub would render as markup. */
const outsideCode = (body: string) => body.replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, '').replace(/\]\([^)\s]*\)/g, ']');
const linkTargets = (body: string) => [...body.replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, '').matchAll(/\]\(([^)\s]*)\)/g)].map(x => x[1]!);

test('code spans contain backticks and control characters', () => {
  assert.equal(code('a`b'), '``a`b``');
  assert.equal(code('`x'), '`` `x ``');
  assert.equal(code('a\nb'), '`a b`');
});
test('dashboard lists every dependency group with pins, links, and tracking issues', () => {
  const body = dashboardBody(flaggedReport(), ctx, new Map([['bad/action', { number: 12, acknowledged: false }]]));
  assert.match(body, /^<!-- osm-action:dashboard -->/);
  assert.match(body, /### 🚩 Flagged by OpenSourceMalware \(1\)\n\n- `bad\/action` — \[OSM report\]\(https:\/\/opensourcemalware\.com\/repository\/https%3A%2F%2Fgithub\.com%2Fbad%2Faction\) · tracked in #12/);
  assert.match(body, /`actions\/checkout@v4` → pin to `actions\/checkout@b{40} # v4`/);
  assert.match(body, /\[`\.github\/workflows\/ci\.yml:7`\]\(https:\/\/github\.com\/owner\/repo\/blob\/c{40}\/\.github\/workflows\/ci\.yml#L7\)/);
  assert.match(body, /### ✅ No OpenSourceMalware match \(1\)\n\n- `actions\/checkout` @ `bbbbbbbbbbbb` \(1 use\)/);
  assert.match(body, /\[workflow run\]\(https:\/\/github\.com\/owner\/repo\/actions\/runs\/1\)/);
});
test('unchecked repositories explain why, and private names are not sent anywhere new', () => {
  const r = report([asset('private/thing', A, A), asset('gone/action', A, undefined, '', [loc('.github/workflows/x.yml', 3)])],
    [verdict('private/thing', 'private')], { complete: false, result: 'incomplete',
      findings: [{ ...loc('.github/workflows/x.yml', 3), code: 'incomplete', level: 'error', message: 'Dependency inspection failed: GitHub API returned HTTP 404' },
        { ...loc('.github/workflows/y.yml', 1), code: 'incomplete', level: 'error', message: 'Invalid or dynamic uses reference' }] });
  const body = dashboardBody(r, ctx, new Map());
  assert.match(body, /### ❔ Could not be checked \(3\)/);
  assert.match(body, /- `gone\/action` — the dependency could not be resolved or inspected: `Dependency inspection failed: GitHub API returned HTTP 404`/);
  assert.match(body, /- `private\/thing` — private repository; its identity is not sent to OSM\n/);
  assert.match(body, /y\.yml:1`\]\(.*\) — `Invalid or dynamic uses reference`/);
});
test('scanned values cannot inject links, mentions, or HTML into issues', () => {
  const evil = '[click](https://evil.example)<img src=x>@everyone';
  const r = report([asset('bad/action', `main${evil}`, undefined, `sub/${evil}`, [loc(`.github/workflows/${evil}.yml`, 2)])],
    [verdict('bad/action', 'flagged-repository', 'https://opensourcemalware.com/x)(y')]);
  for (const body of [dashboardBody(r, ctx, new Map()), flagBody(r, 'bad/action', ctx)]) {
    const visible = outsideCode(body);
    assert.doesNotMatch(visible, /evil\.example|<img|@everyone/);
    for (const target of linkTargets(body)) assert.match(target, /^https:\/\/(github\.com\/owner\/repo\/|opensourcemalware\.com\/)[^()<>\s]*$/);
    assert.match(body, /\[OSM report\]\(https:\/\/opensourcemalware\.com\/x%29%28y\)/);
  }
});
test('large inventories stay within the GitHub issue body limit', () => {
  const assets = Array.from({ length: 3000 }, (_, i) => asset(`org/action-${i}`, 'v1', A, '',
    Array.from({ length: 20 }, (_, j) => loc(`.github/workflows/w${j}.yml`, i))));
  const body = dashboardBody(report(assets, assets.map(a => verdict(a.repository, 'no-verified-match'))), ctx, new Map());
  assert.ok(body.length <= 60_000); assert.match(body, /more \(see the JSON report\)/);
});
test('issues are written only for trusted default-branch runs of the workflow repository', async () => {
  const main = async () => 'main';
  const env = { event: 'push', repository: 'Owner/Repo', ref: 'refs/heads/main' };
  assert.equal(await issueSkipReason(env, 'owner/repo', main), undefined);
  for (const event of ['schedule', 'workflow_dispatch']) assert.equal(await issueSkipReason({ ...env, event }, 'owner/repo', main), undefined);
  assert.match((await issueSkipReason({ ...env, event: 'pull_request_target' }, 'owner/repo', main))!, /events/);
  assert.match((await issueSkipReason(env, 'fork/repo', main))!, /workflow repository/);
  assert.match((await issueSkipReason({ ...env, ref: 'refs/heads/feature' }, 'owner/repo', main))!, /default branch/);
  assert.match((await issueSkipReason({ ...env, event: 'pull_request' }, 'owner/repo', async () => { throw new Error('no lookup'); }))!, /events/);
});

interface Stored { number: number; title: string; body: string; state: 'open' | 'closed'; state_reason: string | null; labels: string[] }
/** An in-memory GitHub Issues API. */
function github(seed: Partial<Stored>[] = []) {
  const issues: Stored[] = seed.map((x, i) => ({ number: i + 1, title: '', body: '', state: 'open', state_reason: null, labels: [LABEL], ...x }));
  const comments: { number: number; body: string }[] = [];
  const writes: string[] = [];
  let label = false;
  const view = (x: Stored) => ({ ...x, html_url: `https://github.com/owner/repo/issues/${x.number}` });
  const http = new Http((async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/repos/owner/repo', '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (method !== 'GET') writes.push(`${method} ${path}`);
    if (method === 'GET' && path === '') return json({ default_branch: 'main' });
    if (path === `/labels/${LABEL}`) return label ? json({ name: LABEL }) : json({ message: 'Not Found' }, 404);
    if (method === 'POST' && path === '/labels') { label = true; return json({ name: body.name }, 201); }
    if (method === 'GET' && path === '/issues') {
      assert.equal(url.searchParams.get('labels'), LABEL); assert.equal(url.searchParams.get('state'), 'all');
      const page = Number(url.searchParams.get('page'));
      return json(issues.filter(x => x.labels.includes(LABEL)).slice((page - 1) * 100, page * 100).map(view));
    }
    if (method === 'POST' && path === '/issues') {
      const created: Stored = { number: issues.length + 1, title: body.title, body: body.body, state: 'open', state_reason: null, labels: body.labels };
      issues.push(created); return json(view(created), 201);
    }
    const match = /^\/issues\/(\d+)(\/comments)?$/.exec(path);
    const issue = match && issues.find(x => x.number === Number(match[1]));
    if (issue && method === 'PATCH') { Object.assign(issue, body); return json(view(issue)); }
    if (issue && method === 'POST' && match[2]) { comments.push({ number: issue.number, body: body.body }); return json({}, 201); }
    throw new Error(`Unexpected ${method} ${url.pathname}`);
  }) as Fetch, async () => {});
  return { sync: new IssueSync('token', 'owner/repo', http), issues, comments, writes };
}

test('first sync creates the label, a dashboard, and one issue per flagged repository', async () => {
  const api = github();
  const outcome = await api.sync.sync(flaggedReport(), ctx);
  assert.deepEqual(api.issues.map(x => x.title), ['🚩 OpenSourceMalware flags bad/action', 'OSM Actions Dashboard']);
  assert.ok(api.issues.every(x => x.labels.includes(LABEL)));
  assert.match(api.issues[0]!.body, /<!-- osm-action:flagged:bad\/action -->/);
  assert.match(api.issues[1]!.body, /tracked in #1/);
  assert.equal(outcome.dashboard, 'https://github.com/owner/repo/issues/2'); assert.deepEqual(outcome.opened, [1]);
  assert.ok(api.writes.includes('POST /labels'));
});
test('repeated syncs update in place without duplicates', async () => {
  const api = github();
  await api.sync.sync(flaggedReport(), ctx); await api.sync.sync(flaggedReport(), ctx);
  assert.equal(api.issues.length, 2); assert.equal(api.comments.length, 0);
  assert.equal(api.writes.filter(x => x === 'POST /issues').length, 2);
});
test('alerts close when the repository is unflagged or gone, and reopen when flagged again', async () => {
  const api = github();
  await api.sync.sync(flaggedReport(), ctx);
  await api.sync.sync(report([asset('bad/action', A, A)], [verdict('bad/action', 'no-verified-match')]), ctx);
  assert.equal(api.issues[0]!.state, 'closed'); assert.equal(api.issues[0]!.state_reason, 'completed');
  assert.match(api.comments.at(-1)!.body, /no longer flags/);
  await api.sync.sync(flaggedReport(), ctx);
  assert.equal(api.issues[0]!.state, 'open'); assert.equal(api.issues.length, 2);
  assert.match(api.comments.at(-1)!.body, /Detected again/);
  await api.sync.sync(report([], []), ctx);
  assert.equal(api.issues[0]!.state, 'closed'); assert.match(api.comments.at(-1)!.body, /No longer used/);
});
test('alerts stay open when the scan could not confirm the repository is clean', async () => {
  const api = github();
  await api.sync.sync(flaggedReport(), ctx);
  await api.sync.sync(report([], [], { complete: false, result: 'incomplete' }), ctx);
  await api.sync.sync(report([asset('bad/action', A, A)], [verdict('bad/action', 'error')], { complete: false, result: 'incomplete' }), ctx);
  assert.equal(api.issues[0]!.state, 'open');
});
test('closing an alert as not planned acknowledges it without hiding it from the dashboard', async () => {
  const api = github();
  await api.sync.sync(flaggedReport(), ctx);
  Object.assign(api.issues[0]!, { state: 'closed', state_reason: 'not_planned' });
  await api.sync.sync(flaggedReport(), ctx);
  assert.equal(api.issues[0]!.state, 'closed'); assert.equal(api.issues.length, 2);
  assert.match(api.issues[1]!.body, /acknowledged in #1/);
});
test('a dashboard closed by a maintainer keeps updating without reopening; concurrent duplicates are superseded', async () => {
  const closed = github([{ body: '<!-- osm-action:dashboard -->\nold', state: 'closed', state_reason: 'completed' }]);
  await closed.sync.sync(report([], []), ctx);
  assert.equal(closed.issues.length, 1); assert.equal(closed.issues[0]!.state, 'closed');
  assert.match(closed.issues[0]!.body, /## OSM Actions Dashboard/);
  const dupes = github([{ body: '<!-- osm-action:dashboard -->' }, { body: '<!-- osm-action:dashboard -->' }]);
  const outcome = await dupes.sync.sync(report([], []), ctx);
  assert.equal(outcome.dashboard, 'https://github.com/owner/repo/issues/1');
  assert.equal(dupes.issues[1]!.state, 'closed'); assert.match(dupes.issues[1]!.body, /^<!-- osm-action:superseded -->\nSuperseded by #1/);
});
test('truncation keeps every scanned value inside a code span', () => {
  const name = (i: number) => `${'w'.repeat(900)}${i}<img src=x>@octocat`;
  const assets = Array.from({ length: 12 }, (_, i) => asset('bad/action', A, A, `p${i}`,
    Array.from({ length: 20 }, (_, j) => ({ ...loc(`.github/workflows/${name(j)}.yml`, j + 1),
      chain: [`${ROOT}:.github/workflows/${name(j)}.yml`, `bad/action@${A}:p${i}/action.yml`] }))));
  const r = report(assets, [verdict('bad/action', 'flagged-repository')]);
  const huge = report(Array.from({ length: 200 }, (_, i) => asset(`org/a${i}`, `v1-${name(i)}`, undefined, '',
    Array.from({ length: 5 }, (_, j) => loc(`.github/workflows/${name(j)}.yml`, j + 1)))), []);
  for (const body of [flagBody(r, 'bad/action', ctx), dashboardBody(huge, ctx, new Map())]) {
    assert.ok(body.length <= 60_000, String(body.length));
    assert.match(body, /Truncated to fit the GitHub issue size limit|more \(see the JSON report\)/);
    assert.doesNotMatch(outsideCode(body), /<img|@octocat/);
  }
  assert.match(flagBody(r, 'bad/action', ctx), /### What to do/);
});
test('markers inside scanned values cannot change an issue identity', async () => {
  const api = github();
  const tricky = () => report([asset('bad/action', A, A, '<!-- osm-action:dashboard -->'),
    asset('other/action', A, A, '<!-- osm-action:flagged:other/action -->')],
    [verdict('bad/action', 'flagged-repository'), verdict('other/action', 'no-verified-match')]);
  await api.sync.sync(tricky(), ctx); await api.sync.sync(tricky(), ctx);
  assert.deepEqual(api.issues.map(x => [x.title, x.state]), [['🚩 OpenSourceMalware flags bad/action', 'open'], ['OSM Actions Dashboard', 'open']]);
  assert.match(api.issues[0]!.body, /^<!-- osm-action:flagged:bad\/action -->/);
});
test('acknowledging the surviving alert holds after concurrent duplicates were superseded', async () => {
  const marker = '<!-- osm-action:flagged:bad/action -->\nold';
  const api = github([{ body: marker }, { body: marker }]);
  await api.sync.sync(flaggedReport(), ctx);
  assert.equal(api.issues[1]!.state, 'closed');
  Object.assign(api.issues[0]!, { state: 'closed', state_reason: 'not_planned' });
  await api.sync.sync(flaggedReport(), ctx);
  assert.deepEqual(api.issues.slice(0, 2).map(x => x.state), ['closed', 'closed']);
  assert.match(api.issues.find(x => x.title === 'OSM Actions Dashboard')!.body, /acknowledged in #1/);
});
test('issue creation is never replayed after a server error', async () => {
  let calls = 0;
  const http = new Http((async () => { calls++; return new Response('{}', { status: 502 }); }) as Fetch, async () => {});
  await assert.rejects(http.json(new URL('https://api.github.com/repos/o/r/issues'), 't', 1000, { method: 'POST', body: {} }), /502/);
  assert.equal(calls, 1);
  await assert.rejects(http.json(new URL('https://api.opensourcemalware.com/x'), 't', 1000, { method: 'POST', body: {} }), /Disallowed/);
});
