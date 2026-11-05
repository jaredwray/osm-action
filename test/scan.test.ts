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
  flagged: string[] = [], policy: Partial<Policy> = {}, privateRepos: string[] = [],
  canonicalNames: Record<string, string> = {}) {
  const calls: string[] = [];
  const resolver: Resolver = { async resolve(repo, ref) {
    if (!remotes[repo]) throw new Error('Unavailable');
    return { source: new Memory(`${repo}@${ref}`, remotes[repo]), sha: /^[a-f\d]{40}$/.test(ref) ? ref : A,
      private: privateRepos.includes(repo), name: canonicalNames[repo] ?? repo };
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
    async resolve() { return { source: new Memory('good', { 'action.yml': js }), sha: A, private: false, name: 'good/action' }; }
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
test('invalid YAML, duplicates, custom tags, mistyped aliases, and malformed jobs are rejected', async t => {
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
test('root local actions are inspected after checkout, including nested dependencies', async t => {
  for (const name of ['action.yml', 'action.yaml']) await t.test(name, async () => {
    const files = { '.github/workflows/ci.yml': `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${A}\n      - uses: ./\n`,
      [name]: `runs:\n  using: composite\n  steps:\n    - uses: nested/action@${B}\n` };
    const remotes = { 'actions/checkout': { 'action.yml': js }, 'nested/action': { 'action.yml': js } };
    const { report, calls } = await fixture(files, remotes);
    assert.equal(report.result, 'pass'); assert.equal(report.complete, true);
    assert.ok(report.files.some(x => x.source === 'root' && x.path === name));
    assert.ok(calls.includes('nested/action'));
    const flagged = (await fixture(files, remotes, ['nested/action'])).report;
    assert.equal(flagged.result, 'fail');
    assert.ok(flagged.findings.some(x => x.code === 'flagged-repository' && x.chain.includes(`root:${name}`)));
  });
});
test('root local action still requires a known workspace', async () => {
  const { report } = await fixture({ '.github/workflows/ci.yml': workflow('./'), 'action.yml': js }, {});
  assert.equal(report.result, 'incomplete');
});
test('checkout must prove cleanup before re-establishing local workspace contents', async t => {
  for (const [clean, expected] of [['false', 'incomplete'], ["'false'", 'incomplete'],
    ['${{ inputs.clean }}', 'incomplete'], ['true', 'pass'], ["'TRUE'", 'pass']] as const) {
    await t.test(clean, async () => {
      const files = { '.github/workflows/ci.yml': `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${A}\n      - run: echo 'untracked local/action.yml may be created here'\n      - uses: actions/checkout@${A}\n        with:\n          clean: ${clean}\n      - uses: ./local\n`,
        'local/action.yaml': js };
      const { report } = await fixture(files, { 'actions/checkout': { 'action.yml': js } });
      assert.equal(report.result, expected); assert.equal(report.complete, expected === 'pass');
      assert.equal(report.files.some(x => x.path === 'local/action.yaml'), expected === 'pass');
    });
  }
});
test('Dockerfile-only actions honor the coverage policy and still check reputation', async t => {
  for (const name of ['Dockerfile', 'dockerfile']) await t.test(name, async () => {
    const files = { '.github/workflows/ci.yml': workflow(`container/action/subdir@${A}`) };
    const remotes = { 'container/action': { [`subdir/${name}`]: 'FROM scratch\n' } };
    const { report, calls } = await fixture(files, remotes);
    assert.equal(report.result, 'pass'); assert.equal(report.complete, true);
    assert.deepEqual(calls, ['container/action']);
    assert.equal(report.coverage.gaps, 1);
    assert.ok(report.findings.some(x => x.code === 'coverage-gap' && x.file === `subdir/${name}`));
    assert.equal((await fixture(files, remotes, [], { failOnGaps: true })).report.result, 'fail');
    assert.equal((await fixture(files, remotes, ['container/action'])).report.result, 'fail');
  });
});
test('action metadata takes precedence over a Dockerfile fallback', async () => {
  const { report } = await fixture({ '.github/workflows/ci.yml': workflow(`container/action@${A}`) },
    { 'container/action': { 'action.yml': 'runs: [', Dockerfile: 'FROM scratch\n' } });
  assert.equal(report.result, 'incomplete');
});

test('a composite shared by many workflows is traversed once without exhausting budgets', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 60; i++) files[`.github/workflows/w${i}.yml`] =
    `jobs:\n  a:\n    steps:\n      - uses: shared/composite@${A}\n      - run: echo ${i}\n`;
  files['.github/workflows/w59.yml'] += `      - uses: bad/action@${B}\n`;
  const { report } = await fixture(files, {
    'shared/composite': { 'action.yml': `runs:\n  using: composite\n  steps:\n    - uses: good/action@${A}\n    - run: echo shared\n      shell: bash\n` },
    'good/action': { 'action.yml': js }, 'bad/action': { 'action.yml': js }
  }, ['bad/action']);
  assert.equal(report.result, 'fail'); assert.equal(report.complete, true);
  assert.equal(report.findings.filter(x => x.source === `shared/composite@${A}`).length, 1);
  assert.equal(report.findings.filter(x => x.source === `good/action@${A}`).length, 1);
  assert.equal(report.assets.find(x => x.repository === 'shared/composite')!.locations.length, 60);
  assert.ok(report.findings.some(x => x.code === 'flagged-repository' && x.file === '.github/workflows/w59.yml'));
});
test('a document reached with a different workspace state is still traversed in that state', async () => {
  const files = { '.github/workflows/a.yml': `jobs:\n  a:\n    steps:\n      - uses: shared/composite@${A}\n`,
    '.github/workflows/b.yml': `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${A}\n      - uses: shared/composite@${A}\n`,
    'local/action.yml': js };
  const remotes = { 'actions/checkout': { 'action.yml': js },
    'shared/composite': { 'action.yml': 'runs:\n  using: composite\n  steps:\n    - uses: ./local\n' } };
  const { report } = await fixture(files, remotes);
  assert.equal(report.result, 'incomplete');
  assert.ok(report.files.some(x => x.source === 'root' && x.path === 'local/action.yml'));
});
test('YAML anchors and aliases are supported with accurate lines', async () => {
  const text = `on: push\nx-os: &os ubuntu-latest\nx-steps: &steps\n  - uses: bad/action@${B}\njobs:\n  a:\n    runs-on: *os\n    steps: *steps\n`;
  const { report } = await fixture({ '.github/workflows/a.yml': text }, { 'bad/action': { 'action.yml': js } }, ['bad/action']);
  assert.equal(report.result, 'fail'); assert.equal(report.complete, true);
  assert.equal(report.findings.find(x => x.code === 'flagged-repository')!.line, 4);
});
test('exponential alias expansion and merge keys are rejected', async t => {
  const bomb = 'a: &a [x, x, x, x, x, x, x, x, x, x]\n' + Array.from({ length: 8 }, (_, i) =>
    `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [${Array(10).fill(`*${String.fromCharCode(97 + i)}`).join(', ')}]`).join('\n') +
    `\njobs:\n  a:\n    steps:\n      - run: echo\n`;
  const merge = `x: &base\n  uses: good/action@${A}\njobs:\n  a:\n    steps:\n      - <<: *base\n`;
  for (const [name, text] of [['bomb', bomb], ['merge', merge]] as const) await t.test(name, async () =>
    assert.equal((await fixture({ '.github/workflows/a.yml': text }, { 'good/action': { 'action.yml': js } })).report.result, 'incomplete'));
});
test('checkout of the triggering revision by expression establishes the local workspace', async t => {
  for (const [inputs, expected] of [['ref: ${{ github.sha }}', 'pass'],
    ['ref: ${{ github.event.pull_request.head.sha }}', 'incomplete'],
    ['repository: ${{ github.repository }}\n          ref: ${{github.sha}}', 'pass'],
    ['ref: ${{ github.head_ref }}', 'incomplete'], ['repository: ${{ github.event.pull_request.head.repo.full_name }}', 'incomplete'],
    ['ref: ${{ github.sha }}\n          path: elsewhere', 'incomplete']] as const) {
    await t.test(inputs, async () => {
      const files = { '.github/workflows/a.yml': `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${A}\n        with:\n          ${inputs}\n      - uses: ./local\n`,
        'local/action.yml': js };
      assert.equal((await fixture(files, { 'actions/checkout': { 'action.yml': js } })).report.result, expected);
    });
  }
});
test('OSM receives GitHub canonical repository casing', async () => {
  const { calls } = await fixture({ '.github/workflows/a.yml': workflow(`mixed/action@${A}`) },
    { 'mixed/action': { 'action.yml': js } }, [], {}, [], { 'mixed/action': 'Mixed/Action' });
  assert.deepEqual(calls, ['Mixed/Action']);
});
test('flagged findings link the OSM report when provided', async () => {
  const url = 'https://opensourcemalware.com/repository/https%3A%2F%2Fgithub.com%2Fbad%2Faction';
  const report = await scan(new Memory('root', { '.github/workflows/a.yml': workflow(`bad/action@${A}`) }), {
    async resolve() { return { source: new Memory('bad', { 'action.yml': js }), sha: A, private: false, name: 'bad/action' }; }
  }, { async check(repo) { return { repository: repo, state: 'flagged-repository', checkedAt: '', reportUrl: url }; } });
  assert.ok(report.findings.some(x => x.code === 'flagged-repository' && x.message.includes(url)));
});
