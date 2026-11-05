import { createHash } from 'node:crypto';
import { LineCounter, parseDocument } from 'yaml';
import { filePath, object, repository, ScanError, SHA } from './model.ts';
import type { Asset, Location, Report } from './model.ts';
import type { Intelligence } from './osm.ts';
import type { Resolver, Source } from './source.ts';

export interface Policy { requireSha: boolean; failOnGaps: boolean; maxDepth: number; maxAssets: number; maxDocuments: number }
export const defaultPolicy: Policy = { requireSha: true, failOnGaps: false, maxDepth: 10, maxAssets: 100, maxDocuments: 300 };
export async function scan(root: Source, resolver: Resolver, intel: Intelligence,
  policy: Policy = defaultPolicy): Promise<Report> {
  const report: Report = { schemaVersion: 1, scannerVersion: '0.1.0', startedAt: new Date().toISOString(), finishedAt: '',
    target: root.id, scope: 'github-repository-intelligence', result: 'incomplete', complete: true,
    assets: [], verdicts: [], findings: [], files: [],
    coverage: { checkedRepositories: 0, unresolved: 0, gaps: 0,
      exclusions: ['Package malware and vulnerabilities', 'Container contents and reputation',
        'JavaScript/native action code and bundled dependencies', 'Shell scripts and runtime downloads',
        'Runner integrity', 'Commit authenticity and fork-network impostor commits'] } };
  const assets = new Map<string, Asset>();
  const visibility = new Map<string, boolean>();
  const contents = new Map<string, Promise<string | undefined>>();
  let documents = 0;
  let nodes = 0;
  const consumeNode = () => {
    if (++nodes > 3000) throw new Error('Workflow node budget exhausted');
  };
  const add = (code: string, message: string, loc: Location, level: 'warning' | 'error' = 'error') => {
    report.findings.push({ code, message, level, ...loc });
  };
  const incomplete = (message: string, loc: Location) => {
    report.complete = false; report.coverage.unresolved++; add('incomplete', message, loc);
  };
  const gap = (message: string, loc: Location) => {
    report.coverage.gaps++; add('coverage-gap', message, loc, policy.failOnGaps ? 'error' : 'warning');
  };
  async function read(source: Source, path: string) {
    const key = `${source.id}:${path}`;
    let cached = contents.get(key);
    if (!cached) {
      if (contents.size >= policy.maxDocuments * 2) throw new Error('File budget exhausted');
      cached = source.read(path).then(text => {
        if (text !== undefined) report.files.push({ source: source.id, path,
          sha256: createHash('sha256').update(text).digest('hex') });
        return text;
      });
      contents.set(key, cached);
    }
    return cached;
  }
  async function use(value: unknown, kind: 'action' | 'workflow', source: Source, loc: Location,
    stack: string[], workspaceKnown: boolean) {
    if (typeof value !== 'string' || !value || value.includes('${{')) { incomplete('Invalid or dynamic uses reference', loc); return; }
    if (value.startsWith('docker://')) { gap('Container image scanning is outside this release’s scope', loc); return; }
    try {
      if (value.startsWith('./')) {
        // ./ is a valid action directory, but never a reusable workflow file.
        const path = kind === 'action' && value === './' ? '' : filePath(value);
        if (kind === 'workflow') {
          if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) throw new Error('Invalid local reusable workflow');
          await visit(source, path, kind, loc.chain, stack, false);
        } else if (workspaceKnown) {
          // Step-level ./ paths refer to the caller workspace, not the remote action's directory.
          await action(root, path, loc.chain, stack, workspaceKnown);
        } else incomplete('Local action workspace is unknown; use a default checkout of the scanned revision before local actions', loc);
        return;
      }
      const match = /^([^/]+\/[^/@]+)(\/[^@]+)?@([^\s@]+)$/.exec(value);
      if (!match) throw new Error('Invalid remote uses reference');
      const repo = repository(match[1]!);
      const path = match[2] ? filePath(match[2].slice(1)) : '';
      const ref = match[3]!;
      if (kind === 'workflow' && !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) throw new Error('Invalid reusable workflow path');
      const key = `${repo}/${path}@${ref}`;
      let asset = assets.get(key);
      if (!asset) {
        if (assets.size >= policy.maxAssets) throw new Error('Dependency budget exhausted');
        asset = { repository: repo, path, requestedRef: ref, locations: [] };
        assets.set(key, asset); report.assets.push(asset);
      }
      asset.locations.push(loc);
      if (!SHA.test(ref)) add('mutable-reference', 'Action or workflow must be pinned to a full commit SHA', loc,
        policy.requireSha ? 'error' : 'warning');
      const resolved = await resolver.resolve(repo, ref);
      asset.resolvedSha = resolved.sha;
      visibility.set(repo, resolved.private);
      if (kind === 'workflow') await visit(resolved.source, path, kind, loc.chain, stack, false);
      else await action(resolved.source, path, loc.chain, stack, workspaceKnown);
    } catch (error) { incomplete(error instanceof ScanError ? `Dependency inspection failed: ${error.message}` :
      'Dependency could not be safely resolved or exceeded scan limits', loc); }
  }
  async function action(source: Source, path: string, chain: string[], stack: string[], workspaceKnown: boolean) {
    const prefix = path ? `${path}/` : '';
    for (const name of ['action.yml', 'action.yaml']) {
      if (await read(source, prefix + name) !== undefined) {
        await visit(source, prefix + name, 'action', chain, stack, workspaceKnown); return;
      }
    }
    // The runner supports Dockerfile-only actions after both metadata names.
    for (const name of ['Dockerfile', 'dockerfile']) {
      const file = prefix + name;
      if (await read(source, file) !== undefined) {
        gap('Dockerfile-only action contents and images are not inspected', {
          source: source.id, file, line: 1, chain: [...chain, `${source.id}:${file}`]
        });
        return;
      }
    }
    throw new Error('Missing action metadata');
  }
  async function visit(source: Source, path: string, kind: 'action' | 'workflow',
    ancestors: string[], stack: string[], workspaceKnown: boolean) {
    const identity = `${source.id}:${path}`;
    const chain = [...ancestors, identity];
    const base: Location = { source: source.id, file: path, line: 1, chain };
    if (stack.includes(identity) || stack.length >= policy.maxDepth || ++documents > policy.maxDocuments) {
      incomplete('Dependency cycle, depth limit, or document budget reached', base); return;
    }
    const nextStack = [...stack, identity];
    try {
      const text = await read(source, path);
      if (text === undefined || Buffer.byteLength(text) > 512_000) throw new Error('Missing or oversized metadata');
      const lines = new LineCounter();
      const doc = parseDocument(text, { lineCounter: lines, uniqueKeys: true, strict: true, schema: 'core' });
      if (doc.errors.length || doc.warnings.length) throw new Error('Invalid YAML');
      const data: unknown = doc.toJS({ maxAliasCount: 0 });
      if (!object(data)) throw new Error('Expected YAML mapping');
      const at = (keys: (string | number)[]): Location => {
        const node = doc.getIn(keys, true) as { range?: number[] } | undefined;
        return { ...base, line: node?.range?.[0] === undefined ? 1 : lines.linePos(node.range[0]).line };
      };
      async function steps(value: unknown, keys: (string | number)[], initialWorkspace: boolean) {
        if (!Array.isArray(value)) throw new Error('Expected steps array');
        let known = initialWorkspace;
        for (let i = 0; i < value.length; i++) {
          consumeNode();
          const step = value[i];
          if (!object(step) || ('uses' in step) === ('run' in step)) throw new Error('Invalid step');
          if ('uses' in step) {
            await use(step.uses, 'action', source, at([...keys, i, 'uses']), nextStack, known);
            if (typeof step.uses === 'string' && /^actions\/checkout@/.test(step.uses)) {
              const inputs = step.with;
              const defaultSource = inputs === undefined || (object(inputs) &&
                !['repository', 'ref', 'path', 'sparse-checkout'].some(k => k in inputs));
              // Disabled or dynamic cleanup may preserve untracked action.yml
              // files created by earlier code, overriding tracked action.yaml.
              const cleansWorkspace = inputs === undefined || (object(inputs) &&
                (!('clean' in inputs) || inputs.clean === true ||
                  (typeof inputs.clean === 'string' && inputs.clean.trim().toLowerCase() === 'true')));
              known = !('if' in step) && defaultSource && cleansWorkspace;
            } else {
              // Arbitrary third-party code can replace files in the caller workspace.
              known = false;
            }
          } else {
            if (typeof step.run !== 'string') throw new Error('Invalid run step');
            gap('Shell execution and its packages/downloads are not inspected', at([...keys, i, 'run']));
            known = false;
          }
        }
      }
      if (kind === 'workflow') {
        if (!object(data.jobs) || Object.keys(data.jobs).length === 0) throw new Error('Expected workflow jobs');
        for (const [id, job] of Object.entries(data.jobs)) {
          consumeNode();
          if (!object(job)) throw new Error('Invalid job');
          if ('uses' in job) {
            if ('steps' in job) throw new Error('Invalid reusable workflow job');
            await use(job.uses, 'workflow', source, at(['jobs', id, 'uses']), nextStack, false);
          } else {
            if ('container' in job) gap('Job container scanning is not supported', at(['jobs', id, 'container']));
            if ('services' in job) gap('Service container scanning is not supported', at(['jobs', id, 'services']));
            await steps(job.steps, ['jobs', id, 'steps'], false);
          }
        }
      } else {
        if (!object(data.runs) || typeof data.runs.using !== 'string') throw new Error('Invalid action metadata');
        if (data.runs.using === 'composite') await steps(data.runs.steps, ['runs', 'steps'], workspaceKnown);
        else if (/^node\d+$/.test(data.runs.using)) {
          if (typeof data.runs.main !== 'string') throw new Error('Missing JavaScript entry point');
          gap('JavaScript action code, pre/post hooks, and bundled packages are not inspected', at(['runs']));
        } else if (data.runs.using === 'docker') gap('Docker action images, Dockerfiles, and hooks are not inspected', at(['runs']));
        else incomplete('Unsupported action runtime', at(['runs', 'using']));
      }
    } catch { incomplete('Workflow/action metadata is missing, invalid, unsafe, or inaccessible', base); }
  }
  const rootLoc: Location = { source: root.id, file: '.github/workflows', line: 1, chain: [root.id] };
  try {
    const workflows = await root.workflows();
    if (!workflows.length) incomplete('No workflow files were found', rootLoc);
    if (workflows.length > 100) incomplete('Workflow count exceeds limit', rootLoc);
    else for (const path of workflows) await visit(root, path, 'workflow', [], [], false);
  } catch { incomplete('Cannot enumerate workflow files', rootLoc); }
  const repos = [...new Set(report.assets.map(x => x.repository))].sort();
  for (const repo of repos) {
    const locations = report.assets.filter(x => x.repository === repo).flatMap(x => x.locations);
    if (!visibility.has(repo)) continue; // Resolution already produced an incomplete finding.
    if (visibility.get(repo)) {
      report.verdicts.push({ repository: repo, state: 'private', checkedAt: new Date().toISOString() });
      for (const loc of locations) incomplete('Private repository identity was not sent to OSM; reputation check is incomplete', loc);
      continue;
    }
    try {
      const verdict = await intel.check(repo);
      report.verdicts.push(verdict);
      report.coverage.checkedRepositories++;
      if (verdict.state === 'flagged-repository') for (const loc of locations) {
        add('flagged-repository', 'OSM flags this repository. Applicability to the selected commit needs review; this is not a commit-level malware verdict.', loc);
      }
    } catch (error) {
      report.verdicts.push({ repository: repo, state: 'error', checkedAt: new Date().toISOString() });
      for (const loc of locations) incomplete(error instanceof ScanError ? `OSM lookup failed: ${error.message}` :
        'OSM lookup failed, timed out, exceeded quota, or returned an unsupported response', loc);
    }
  }
  report.result = !report.complete ? 'incomplete' : report.findings.some(x => x.level === 'error') ? 'fail' : 'pass';
  report.finishedAt = new Date().toISOString();
  return report;
}
