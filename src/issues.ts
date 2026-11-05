import { Http } from './http.ts';
import type { Write } from './http.ts';
import { object, repository, ScanError, SHA } from './model.ts';
import type { Asset, Location, Report, Verdict } from './model.ts';

export const LABEL = 'osm-action';
const DASHBOARD = '<!-- osm-action:dashboard -->';
const FLAG = /<!-- osm-action:flagged:([a-z\d][a-z\d-]*\/[a-z\d_.-]+) -->/;
const flagMarker = (repo: string) => `<!-- osm-action:flagged:${repo} -->`;
const MAX_BODY = 60_000; // GitHub rejects issue bodies over 65,536 characters.
const MAX_PAGES = 10;
const ISSUE_EVENTS = ['push', 'schedule', 'workflow_dispatch'];

export interface IssueContext {
  /** owner/repository that receives issues (the workflow's own repository). */
  repository: string;
  /** Link to the workflow run that produced the report. */
  runUrl?: string;
}
export interface Issue { number: number; open: boolean; reason: string | null; body: string; url: string }
export interface IssueOutcome { dashboard: string; opened: number[]; closed: number[] }

// --- Rendering -----------------------------------------------------------
// Every scanned value is rendered inside a code span, where GitHub resolves no
// links, mentions, emphasis, or HTML. Link targets are built from validated parts.

/** A CommonMark code span that safely contains any single-line text. */
export function code(value: string): string {
  const text = value.replace(/[\x00-\x1f\x7f]/g, ' ');
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(x => x.length));
  const fence = '`'.repeat(longest + 1);
  const pad = /^[` ]|[` ]$/.test(text) ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}
const segment = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const linkTarget = (url: string) => url.replace(/[()\s]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const short = (sha: string) => sha.slice(0, 12);
/** Splits a source id of the form owner/repository@sha. */
function revision(id: string): { repo: string; sha: string } | undefined {
  const match = /^([a-z\d][a-z\d-]*\/[a-z\d_.-]+)@([a-f\d]{40})$/i.exec(id);
  return match ? { repo: match[1]!, sha: match[2]! } : undefined;
}
function where(loc: Location, target: string): string {
  const at = revision(loc.source);
  const label = code(loc.source === target ? `${loc.file}:${loc.line}` : `${at?.repo ?? loc.source}/${loc.file}:${loc.line}`);
  if (!at) return label;
  const path = loc.file.split('/').map(segment).join('/');
  return `[${label}](https://github.com/${at.repo}/blob/${at.sha}/${path}#L${loc.line})`;
}
function places(locations: Location[], target: string, limit: number, indent = '  '): string[] {
  const unique = [...new Map(locations.map(x => [`${x.source}\0${x.file}\0${x.line}`, x])).values()];
  const lines = unique.slice(0, limit).map(loc => `${indent}- used in ${where(loc, target)}`);
  if (unique.length > limit) lines.push(`${indent}- …and ${unique.length - limit} more (see the JSON report)`);
  return lines;
}
const uses = (asset: Asset) => `${asset.repository}${asset.path ? `/${asset.path}` : ''}`;
interface View { target: string; scanned?: { repo: string; sha: string }; verdicts: Map<string, Verdict>;
  byRepo: Map<string, Asset[]> }
function view(report: Report): View {
  const byRepo = new Map<string, Asset[]>();
  for (const asset of report.assets) byRepo.set(asset.repository, [...(byRepo.get(asset.repository) ?? []), asset]);
  return { target: report.target, scanned: revision(report.target), byRepo,
    verdicts: new Map(report.verdicts.map(v => [v.repository, v])) };
}
function header(report: Report, v: View, ctx: IssueContext): string {
  const scanned = v.scanned ? `${code(v.scanned.repo)} at ${code(short(v.scanned.sha))}` : code(report.target);
  return `Scan of ${scanned} · **${report.result.toUpperCase()}** · ${report.coverage.checkedRepositories} repositories checked` +
    (ctx.runUrl ? ` · [workflow run](${linkTarget(ctx.runUrl)})` : '');
}

/** The always-current inventory issue. `tracking` maps flagged repositories to their issue numbers. */
export function dashboardBody(report: Report, ctx: IssueContext, tracking: Map<string, { number: number; acknowledged: boolean }>): string {
  const v = view(report);
  const repos = [...v.byRepo.keys()].sort();
  const flagged = repos.filter(r => v.verdicts.get(r)?.state === 'flagged-repository');
  const clean = repos.filter(r => v.verdicts.get(r)?.state === 'no-verified-match');
  const unchecked = repos.filter(r => !flagged.includes(r) && !clean.includes(r));
  const mutable = report.assets.filter(a => !SHA.test(a.requestedRef));
  const at = (l: Location) => `${l.source}\0${l.file}\0${l.line}`;
  const incomplete = report.findings.filter(f => f.code === 'incomplete');
  // Explain each unchecked repository with the first problem recorded at one of its uses.
  const reasons = new Map(unchecked.map(repo => {
    const spots = new Set(v.byRepo.get(repo)!.flatMap(a => a.locations).map(at));
    return [repo, { spots, finding: incomplete.find(f => spots.has(at(f))) }] as const;
  }));
  const claimed = new Set([...reasons.values()].flatMap(x => [...x.spots]));
  const blockers = incomplete.filter(f => !claimed.has(at(f)));
  const render = (limit: number, locs: number) => {
    const lines = [DASHBOARD, '## OSM Actions Dashboard', '', header(report, v, ctx), '',
      `_Updated ${report.finishedAt} by osm-action. Edits to this issue are overwritten on the next scan._`, ''];
    lines.push(`### 🚩 Flagged by OpenSourceMalware (${flagged.length})`, '');
    if (!flagged.length) lines.push('None.', '');
    for (const repo of flagged.slice(0, limit)) {
      const verdict = v.verdicts.get(repo)!;
      const issue = tracking.get(repo);
      lines.push(`- ${code(repo)}${verdict.reportUrl ? ` — [OSM report](${linkTarget(verdict.reportUrl)})` : ''}` +
        (issue ? ` · ${issue.acknowledged ? 'acknowledged in' : 'tracked in'} #${issue.number}` : ''));
      for (const asset of v.byRepo.get(repo)!) lines.push(`  - ${code(`${uses(asset)}@${asset.requestedRef}`)}`,
        ...places(asset.locations, v.target, locs, '    '));
    }
    if (flagged.length) lines.push('');
    lines.push(`### ⚠️ Not pinned to a commit SHA (${mutable.length})`, '');
    if (!mutable.length) lines.push('None.', '');
    for (const asset of mutable.slice(0, limit)) {
      lines.push(`- ${code(`${uses(asset)}@${asset.requestedRef}`)}` + (asset.resolvedSha
        ? ` → pin to ${code(`${uses(asset)}@${asset.resolvedSha} # ${asset.requestedRef}`)}` : ' (could not be resolved)'),
        ...places(asset.locations, v.target, locs));
    }
    if (mutable.length > limit) lines.push(`- …and ${mutable.length - limit} more (see the JSON report)`);
    if (mutable.length) lines.push('');
    lines.push(`### ❔ Could not be checked (${unchecked.length + blockers.length})`, '');
    if (!unchecked.length && !blockers.length) lines.push('None.', '');
    for (const repo of unchecked.slice(0, limit)) {
      const state = v.verdicts.get(repo)?.state;
      const detail = reasons.get(repo)?.finding?.message;
      lines.push(`- ${code(repo)} — ${state === 'private' ? 'private repository; its identity is not sent to OSM'
        : state === 'error' ? 'the OSM lookup failed' : 'the dependency could not be resolved or inspected'}` +
        (detail && state !== 'private' ? `: ${code(detail)}` : ''));
    }
    for (const finding of blockers.slice(0, limit)) {
      lines.push(`- ${where(finding, v.target)} — ${code(finding.message)}`);
    }
    if (unchecked.length > limit || blockers.length > limit) lines.push('- …more in the JSON report');
    if (unchecked.length || blockers.length) lines.push('');
    lines.push(`### ✅ No OpenSourceMalware match (${clean.length})`, '');
    if (!clean.length) lines.push('None.', '');
    for (const repo of clean.slice(0, limit)) {
      const assets = v.byRepo.get(repo)!;
      const pins = [...new Set(assets.map(a => a.resolvedSha ? short(a.resolvedSha) : a.requestedRef))];
      const count = assets.reduce((n, a) => n + a.locations.length, 0);
      lines.push(`- ${code(repo)} @ ${pins.map(code).join(', ')} (${count} ${count === 1 ? 'use' : 'uses'})`);
    }
    if (clean.length > limit) lines.push(`- …and ${clean.length - limit} more (see the JSON report)`);
    lines.push('', '<details><summary>About this dashboard</summary>', '',
      'osm-action checks every repository behind the GitHub Actions and reusable workflows this repository uses, including nested dependencies, against OpenSourceMalware.',
      'A flag is repository-level threat intelligence, not a verdict on the pinned commit. No match does not establish that code is safe.',
      'Each flagged repository gets its own issue, which closes automatically once it is no longer used or flagged. Closing one as **not planned** acknowledges it: it is not reopened, but scans keep failing while the dependency remains.',
      '', '</details>', '');
    return lines.join('\n');
  };
  for (const [limit, locs] of [[200, 5], [50, 3], [10, 1], [0, 0]] as const) {
    const body = render(limit, locs);
    if (body.length <= MAX_BODY) return body;
  }
  return render(0, 0).slice(0, MAX_BODY);
}

/** The alert issue for one flagged repository. */
export function flagBody(report: Report, repo: string, ctx: IssueContext): string {
  const v = view(report);
  const verdict = v.verdicts.get(repo);
  const lines = [flagMarker(repo), `## 🚩 OpenSourceMalware flags ${code(repo)}`, '',
    `OpenSourceMalware has a report for this repository${verdict?.reportUrl ? `: [OSM report](${linkTarget(verdict.reportUrl)})` : '.'}`,
    `It is a GitHub Actions dependency of this repository. ${header(report, v, ctx)}.`, '', '### Where it is used', ''];
  for (const asset of (v.byRepo.get(repo) ?? []).slice(0, 50)) {
    lines.push(`- ${code(`${uses(asset)}@${asset.requestedRef}`)}${asset.resolvedSha ? ` (commit ${code(short(asset.resolvedSha))})` : ''}`);
    for (const loc of asset.locations.slice(0, 20)) {
      lines.push(`  - used in ${where(loc, v.target)}`);
      if (loc.chain.length > 1) lines.push(`    - via ${loc.chain.map(code).join(' → ')}`);
    }
  }
  lines.push('', '### What to do', '',
    '1. Read the OSM report and decide whether it applies to the pinned commit.',
    '2. Remove or replace this dependency in every location above.',
    '3. If workflows already ran it, treat secrets and tokens available to those jobs as exposed and rotate them.', '',
    'This issue closes automatically once the repository is no longer used or flagged. Closing it as **not planned** acknowledges the risk: it will not be reopened, but scans keep failing while the dependency remains.', '');
  return lines.join('\n').slice(0, MAX_BODY);
}

// --- Synchronization -----------------------------------------------------

/** Issues are written only for trusted runs on the default branch of the scanned repository itself. */
export async function issueSkipReason(env: { event?: string; repository?: string; ref?: string },
  scanned: string, defaultBranch: () => Promise<string>): Promise<string | undefined> {
  if (!env.event || !ISSUE_EVENTS.includes(env.event)) {
    return `Issue reporting runs only on ${ISSUE_EVENTS.join(', ')} events`;
  }
  if (!env.repository || repository(env.repository) !== repository(scanned)) {
    return 'Issue reporting runs only when the scanned repository is the workflow repository';
  }
  if (env.ref !== `refs/heads/${await defaultBranch()}`) return 'Issue reporting runs only on the default branch';
}

export class IssueSync {
  constructor(private readonly token: string, private readonly repo: string, private readonly http = new Http()) {
    this.repo = repository(repo);
  }
  private call(path: string, write?: Write) {
    return this.http.json(new URL(`https://api.github.com/repos/${this.repo}${path}`), this.token, 8_000_000, write);
  }
  async defaultBranch(): Promise<string> {
    const meta = await this.call('');
    if (!object(meta) || typeof meta.default_branch !== 'string' || !meta.default_branch) {
      throw new ScanError('Repository default branch is unavailable');
    }
    return meta.default_branch;
  }
  private async ensureLabel() {
    try { await this.call(`/labels/${LABEL}`); return; } catch (error) {
      if (!(error instanceof ScanError) || error.status !== 404) throw error;
    }
    try {
      await this.call('/labels', { method: 'POST', body: { name: LABEL, color: 'b60205',
        description: 'Maintained by osm-action: GitHub Actions dependency intelligence' } });
    } catch (error) {
      // 422: another run created it first.
      if (!(error instanceof ScanError) || error.status !== 422) throw error;
    }
  }
  private async issues(): Promise<Issue[]> {
    const found: Issue[] = [];
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) throw new ScanError(`More than ${MAX_PAGES * 100} ${LABEL} issues; close or relabel old ones`);
      const items = await this.call(`/issues?labels=${LABEL}&state=all&sort=created&direction=asc&per_page=100&page=${page}`);
      if (!Array.isArray(items)) throw new ScanError('Invalid GitHub issue list response');
      for (const item of items) {
        if (!object(item) || 'pull_request' in item) continue;
        if (typeof item.number !== 'number' || !Number.isSafeInteger(item.number) || typeof item.html_url !== 'string' ||
            (item.state !== 'open' && item.state !== 'closed')) throw new ScanError('Invalid GitHub issue response');
        found.push({ number: item.number, open: item.state === 'open', url: item.html_url,
          reason: typeof item.state_reason === 'string' ? item.state_reason : null,
          body: typeof item.body === 'string' ? item.body : '' });
      }
      if (items.length < 100) return found.sort((a, b) => a.number - b.number);
    }
  }
  private async create(title: string, body: string): Promise<Issue> {
    const item = await this.call('/issues', { method: 'POST', body: { title, body, labels: [LABEL] } });
    if (!object(item) || typeof item.number !== 'number' || typeof item.html_url !== 'string') {
      throw new ScanError('Invalid GitHub issue response');
    }
    return { number: item.number, open: true, reason: null, body, url: item.html_url };
  }
  private update(issue: Issue, fields: Record<string, unknown>) {
    return this.call(`/issues/${issue.number}`, { method: 'PATCH', body: fields });
  }
  private comment(issue: Issue, body: string) {
    return this.call(`/issues/${issue.number}/comments`, { method: 'POST', body: { body } });
  }
  /** Close all but the oldest open issue in a group created by concurrent runs. */
  private async dedupe(group: Issue[]): Promise<Issue | undefined> {
    const open = group.filter(x => x.open);
    for (const extra of open.slice(1)) {
      await this.comment(extra, `Superseded by #${open[0]!.number}.`);
      await this.update(extra, { state: 'closed', state_reason: 'completed' });
    }
    return open[0];
  }

  async sync(report: Report, ctx: IssueContext): Promise<IssueOutcome> {
    await this.ensureLabel();
    const existing = await this.issues();
    const outcome: IssueOutcome = { dashboard: '', opened: [], closed: [] };
    const v = view(report);
    const flagged = [...new Set(report.verdicts.filter(x => x.state === 'flagged-repository').map(x => x.repository))].sort();
    const sha = v.scanned ? code(short(v.scanned.sha)) : code(report.target);
    const byFlag = new Map<string, Issue[]>();
    for (const issue of existing) {
      const repo = FLAG.exec(issue.body)?.[1];
      if (repo) byFlag.set(repo, [...(byFlag.get(repo) ?? []), issue]);
    }
    const tracking = new Map<string, { number: number; acknowledged: boolean }>();
    for (const repo of flagged) {
      const group = byFlag.get(repo) ?? [];
      const title = `🚩 OpenSourceMalware flags ${repo}`;
      const body = flagBody(report, repo, ctx);
      const open = await this.dedupe(group);
      const latestClosed = group.filter(x => !x.open).at(-1);
      if (open) {
        await this.update(open, { title, body });
        tracking.set(repo, { number: open.number, acknowledged: false });
      } else if (latestClosed?.reason === 'not_planned') {
        tracking.set(repo, { number: latestClosed.number, acknowledged: true });
      } else if (latestClosed) {
        await this.update(latestClosed, { title, body, state: 'open', state_reason: 'reopened' });
        await this.comment(latestClosed, `Detected again in the scan of ${sha}.`);
        tracking.set(repo, { number: latestClosed.number, acknowledged: false });
        outcome.opened.push(latestClosed.number);
      } else {
        const created = await this.create(title, body);
        tracking.set(repo, { number: created.number, acknowledged: false });
        outcome.opened.push(created.number);
      }
    }
    // Close alerts only when this scan positively shows the repository is gone or unflagged.
    for (const [repo, group] of byFlag) {
      if (flagged.includes(repo)) continue;
      const state = report.verdicts.find(x => x.repository === repo)?.state;
      const gone = !v.byRepo.has(repo) && report.complete;
      if (state !== 'no-verified-match' && !gone) continue;
      for (const issue of group.filter(x => x.open)) {
        await this.comment(issue, gone ? `No longer used as of the scan of ${sha}. Closing.`
          : `OpenSourceMalware no longer flags this repository as of the scan of ${sha}. Closing.`);
        await this.update(issue, { state: 'closed', state_reason: 'completed' });
        outcome.closed.push(issue.number);
      }
    }
    const dashboards = existing.filter(x => x.body.includes(DASHBOARD));
    const body = dashboardBody(report, ctx, tracking);
    // Keep updating a dashboard a maintainer closed, without reopening it.
    const dashboard = await this.dedupe(dashboards) ?? dashboards[0];
    if (dashboard) {
      await this.update(dashboard, { title: 'OSM Actions Dashboard', body });
      outcome.dashboard = dashboard.url;
    } else outcome.dashboard = (await this.create('OSM Actions Dashboard', body)).url;
    return outcome;
  }
}
