import test from 'node:test';
import assert from 'node:assert/strict';
import { scan, defaultPolicy } from '../src/scan.ts';
import type { Policy } from '../src/scan.ts';
import type { Resolver, Source } from '../src/source.ts';
import type { Intelligence } from '../src/osm.ts';
import type { Verdict } from '../src/model.ts';
const A = 'a'.repeat(40), B = 'b'.repeat(40);
const js = 'name: demo\nruns:\n  using: node24\n  main: dist/index.js\n';
class Memory implements Source {
  constructor(public id: string, public files: Record<string, string>) {}
  async workflows() { return Object.keys(this.files).filter(x => x.startsWith('.github/workflows/')); }
  async read(path: string) { return this.files[path]; }
}
const workflow = (uses: string) => `on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${uses}\n`;
async function fixture(files: Record<string, string>, remotes: Record<string, Record<string, string>>,
  flagged: string[] = [], policy: Partial<Policy> = {}, privateRepos: string[] = []) {
  const calls: string[] = [];
  const resolver: Resolver = { async resolve(repo, ref) {
    if (!remotes[repo]) throw new Error('Unavailable');
    return { source: new Memory(`${repo}@${ref}`, remotes[repo]), sha: /^[a-f\d]{40}$/.test(ref) ? ref : A,
      private: privateRepos.includes(repo) };
  } };
  const intel: Intelligence = { async check(repo) { calls.push(repo); return { repository: repo,
    state: flagged.includes(repo) ? 'flagged-repository' : 'no-verified-match', checkedAt: '2026-11-05T00:00:00Z' }; } };
  const report = await scan(new Memory('root', files), resolver, intel, { ...defaultPolicy, ...policy });
  return { report, calls };
}
test('nested composite finding retains the path and source line', async () => {
  const { report } = await fixture({ '.github/workflows/ci.yml': workflow(`good/action@${A}`) }, {
    'good/action': { 'action.yml': `runs:\n  using: composite\n  steps:\n    - uses: bad/action@${B}\n` },
    'bad/action': { 'action.yml': js }
  }, ['bad/action']);
  assert.equal(report.result, 'fail');
  const finding = report.findings.find(x => x.code === 'flagged-repository')!;
  assert.equal(finding.line, 4);
  assert.equal(finding.chain.length, 2);
  assert.match(finding.message, /not a commit-level/);
});
test('recursive reusable workflows are traversed', async () => {
  const { report } = await fixture({ '.github/workflows/ci.yml': `jobs:\n  shared:\n    uses: good/workflows/.github/workflows/build.yml@${A}` }, {
    'good/workflows': { '.github/workflows/build.yml': workflow(`bad/action@${B}`) },
    'bad/action': { 'action.yaml': js }
  }, ['bad/action']);
  assert.equal(report.result, 'fail'); assert.equal(report.assets.length, 2);
});
test('nested local reusable workflows use their owning repository', async () => {
  const { report } = await fixture({ '.github/workflows/ci.yml': `jobs:\n  shared:\n    uses: good/workflows/.github/workflows/build.yml@${A}` }, {
    'good/workflows': { '.github/workflows/build.yml': 'jobs:\n  nested:\n    uses: ./.github/workflows/inner.yml',
      '.github/workflows/inner.yml': workflow(`bad/action@${B}`) }, 'bad/action': { 'action.yml': js }
  }, ['bad/action']);
  assert.equal(report.result, 'fail'); assert.ok(report.assets.some(x => x.repository === 'bad/action'));
});
test('same repository across paths/refs is queried once without losing callers', async () => {
  const { report, calls } = await fixture({ '.github/workflows/a.yml': workflow(`good/action/a@${A}`),
    '.github/workflows/b.yml': workflow(`good/action/b@${B}`) }, {
    'good/action': { 'a/action.yml': js, 'b/action.yml': js }
  });
  assert.deepEqual(calls, ['good/action']); assert.equal(report.assets.length, 2);
  assert.equal(report.result, 'pass'); assert.equal(report.coverage.gaps, 2);
});
test('mutable refs block by default, explicit relaxed policy still records warning', async () => {
  const args: [Record<string, string>, Record<string, Record<string, string>>] = [
    { '.github/workflows/a.yml': workflow('good/action@v1') }, { 'good/action': { 'action.yml': js } }];
  assert.equal((await fixture(...args)).report.result, 'fail');
  const { report } = await fixture(...args, [], { requireSha: false });
  assert.equal(report.result, 'pass'); assert.ok(report.findings.some(x => x.code === 'mutable-reference'));
});
test('unavailable metadata cannot produce a pass', async () => {
  assert.equal((await fixture({ '.github/workflows/a.yml': workflow(`missing/action@${A}`) }, {})).report.result, 'incomplete');
});
test('private repository names never reach OSM', async () => {
  const { report, calls } = await fixture({ '.github/workflows/a.yml': workflow(`private/action@${A}`) },
    { 'private/action': { 'action.yml': js } }, [], {}, ['private/action']);
  assert.deepEqual(calls, []); assert.equal(report.result, 'incomplete');
});
test('API failure is an incomplete scan', async () => {
  const report = await scan(new Memory('root', { '.github/workflows/a.yml': workflow(`good/action@${A}`) }), {
    async resolve() { return { source: new Memory('good', { 'action.yml': js }), sha: A, private: false }; }
  }, { async check(): Promise<Verdict> { throw new Error('token=secret'); } });
  assert.equal(report.result, 'incomplete'); assert.doesNotMatch(JSON.stringify(report), /secret/);
});
test('cycles are reported rather than silently skipped', async () => {
  const { report } = await fixture({ '.github/workflows/a.yml': workflow(`loop/action@${A}`) }, {
    'loop/action': { 'action.yml': `runs:\n  using: composite\n  steps:\n    - uses: loop/action@${A}` }
  });
  assert.equal(report.result, 'incomplete'); assert.ok(report.findings.some(x => /cycle/.test(x.message)));
});
test('dependency budgets fail closed', async () => {
  const { report } = await fixture({ '.github/workflows/a.yml': workflow(`good/action@${A}`) }, {}, [], { maxAssets: 0 });
  assert.equal(report.result, 'incomplete');
});
test('invalid YAML, duplicates, custom tags, aliases, and malformed jobs are rejected', async t => {
  for (const content of ['jobs: [', 'jobs: {}\njobs: {}', 'jobs: !!javascript/function hi',
    'x: &a [1]\njobs: *a', 'jobs: 42', 'jobs: {}', 'jobs:\n  a:\n    steps:\n      - uses: 3',
    'jobs:\n  a:\n    steps:\n      - run: hi\n        uses: good/action@v1']) {
    await t.test(content, async () => assert.equal((await fixture({ '.github/workflows/a.yml': content }, {})).report.result, 'incomplete'));
  }
});
test('dynamic references and traversal are unresolved', async t => {
  for (const ref of ['./../escape', 'good/action/../evil@v1', '${{ matrix.action }}', 'https://host/thing']) {
    await t.test(ref, async () => assert.equal((await fixture({ '.github/workflows/a.yml': workflow(ref) }, {})).report.result, 'incomplete'));
  }
});
test('containers and scripts are visible gaps and optional blockers', async () => {
  const files = { '.github/workflows/a.yml': 'jobs:\n  a:\n    container: alpine\n    services: { db: { image: postgres } }\n    steps:\n      - uses: docker://alpine\n      - run: npm install\n' };
  const { report } = await fixture(files, {});
  assert.equal(report.coverage.gaps, 4); assert.equal(report.result, 'pass');
  assert.equal((await fixture(files, {}, [], { failOnGaps: true })).report.result, 'fail');
});
test('local actions require a known workspace and use caller-root paths', async () => {
  const files = { '.github/workflows/a.yml': `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${A}\n      - uses: ./local\n`, 'local/action.yml': js };
  assert.equal((await fixture(files, { 'actions/checkout': { 'action.yml': js } })).report.result, 'pass');
  assert.equal((await fixture({ ...files, '.github/workflows/a.yml': workflow('./local') }, {})).report.result, 'incomplete');
});
test('conditional or redirected checkout cannot establish a local workspace', async () => {
  const files = { '.github/workflows/a.yml': `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${A}\n        with: { ref: main }\n      - uses: ./local\n`, 'local/action.yml': js };
  assert.equal((await fixture(files, { 'actions/checkout': { 'action.yml': js } })).report.result, 'incomplete');
});
test('repository policy files are never loaded from the candidate', async () => {
  const { report } = await fixture({ '.github/workflows/a.yml': workflow('good/action@main'),
    '.osm.yml': 'require-sha: false\nexclude: ["**"]' }, { 'good/action': { 'action.yml': js } });
  assert.equal(report.result, 'fail');
});
test('empty repositories do not pass', async () => assert.equal((await fixture({}, {})).report.result, 'incomplete'));
test('large step lists cannot expand findings without a bound', async () => {
  const text = 'jobs:\n  a:\n    steps:\n' + '      - run: echo test\n'.repeat(3010);
  const { report } = await fixture({ '.github/workflows/a.yml': text }, {});
  assert.equal(report.result, 'incomplete'); assert.ok(report.findings.length <= 3001);
});
