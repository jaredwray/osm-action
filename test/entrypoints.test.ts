import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const exec = promisify(execFile);
const A = 'a'.repeat(40);
// Tests intercept only HTTP. The actual committed bundle parses files, resolves
// identities, scans, writes outputs, and chooses its process exit code.
const preload = `
import { createHash } from 'node:crypto';
const A = 'a'.repeat(40), T = 'b'.repeat(40);
const workflow = 'jobs:\\n  build:\\n    steps:\\n      - uses: demo/action@' + A + '\\n';
const action = 'runs:\\n  using: node24\\n  main: index.js\\n';
const hash = text => createHash('sha1').update('blob ' + Buffer.byteLength(text) + '\\0').update(text).digest('hex');
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  if (init.redirect !== 'error') throw new Error('Redirects must be refused');
  if (u.hostname === 'api.opensourcemalware.com') {
    if (process.env.TEST_SCENARIO === 'outage') return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({ malicious: process.env.TEST_SCENARIO === 'flagged',
      report_type: 'repository', resource_identifier: 'https://github.com/demo/action', details: { status: 'verified' } }));
  }
  if (u.hostname !== 'api.github.com') throw new Error('Unexpected host');
  const repo = u.pathname.includes('/demo/action') ? 'demo/action' : 'demo/root';
  const text = repo === 'demo/action' ? action : workflow;
  const path = repo === 'demo/action' ? 'action.yml' : '.github/workflows/ci.yml';
  let response;
  if (u.pathname.endsWith('/commits/' + A)) response = { sha: A, commit: { tree: { sha: T } } };
  else if (u.pathname.endsWith('/git/trees/' + T)) response = { truncated: false,
    tree: [{ path, sha: hash(text), type: 'blob', mode: '100644', size: Buffer.byteLength(text) }] };
  else if (u.pathname.includes('/git/blobs/')) response = { encoding: 'base64', content: Buffer.from(text).toString('base64') };
  else response = { full_name: repo, private: false };
  return new Response(JSON.stringify(response));
};
`;
async function runBundle(entry: string, args: string[], env: NodeJS.ProcessEnv) {
  try { const result = await exec(process.execPath, args.concat(resolve(`dist/${entry}.cjs`)), { env });
    return { ...result, code: 0 }; }
  catch (error) { const result = error as { stdout: string; stderr: string; code: number };
    return result; }
}
test('bundled Action produces outputs and correct verdicts without a candidate checkout', async t => {
  for (const [scenario, expectedCode, expectedResult] of [['pass', 0, 'pass'], ['flagged', 1, 'fail'], ['outage', 2, 'incomplete']] as const) {
    await t.test(scenario, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'osm-entrypoint-'));
      try {
        const loader = join(dir, 'network.mjs'); await writeFile(loader, preload);
        const result = await runBundle('action', ['--import', loader], { ...process.env,
          TEST_SCENARIO: scenario, INPUT_REPOSITORY: 'demo/root', INPUT_SHA: A,
          'INPUT_OSM-TOKEN': 'test-secret-must-not-appear', 'INPUT_GITHUB-TOKEN': 'test-github-secret',
          RUNNER_TEMP: dir, GITHUB_OUTPUT: join(dir, 'outputs'), GITHUB_STEP_SUMMARY: join(dir, 'summary'),
          GITHUB_WORKSPACE: join(dir, 'nonexistent') });
        assert.equal(result.code, expectedCode, result.stderr);
        const outputs = await readFile(join(dir, 'outputs'), 'utf8');
        assert.match(outputs, new RegExp(`result=${expectedResult}`));
        const path = /^report-path=(.+)$/m.exec(outputs)![1]!;
        const report = JSON.parse(await readFile(path, 'utf8'));
        assert.equal(report.result, expectedResult); assert.equal(report.coverage.checkedRepositories, scenario === 'outage' ? 0 : 1);
        assert.doesNotMatch(JSON.stringify(report), /test-secret|test-github-secret/);
        // add-mask necessarily emits the secret to the runner's command parser; nowhere else may echo it.
        const remainingLogs = result.stdout.split('\n').filter(x => !x.startsWith('::add-mask::')).join('\n');
        assert.doesNotMatch(remainingLogs + result.stderr, /test-secret|test-github-secret/);
      } finally { await rm(dir, { recursive: true, force: true }); }
    });
  }
});
test('bundled Action missing token fails before network or success output', async () => {
  const result = await runBundle('action', [], { ...process.env, INPUT_REPOSITORY: 'demo/root', INPUT_SHA: A,
    'INPUT_OSM-TOKEN': '', RUNNER_TEMP: tmpdir(), GITHUB_OUTPUT: '/unwritten', GITHUB_STEP_SUMMARY: '/unwritten' });
  assert.equal(result.code, 2); assert.match(result.stdout, /incomplete/);
  assert.match(result.stdout, /OSM_API_TOKEN is required/);
});
test('bundled CLI explains an existing output file without echoing its path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'osm-cli-'));
  try {
    await mkdir(join(dir, '.github/workflows'), { recursive: true });
    await writeFile(join(dir, '.github/workflows/ci.yml'), 'jobs:\n  build:\n    steps:\n      - run: echo\n');
    const output = join(dir, 'secret-name.json'); await writeFile(output, '{}');
    const result = await exec(process.execPath, [resolve('dist/cli.cjs'), '--path', dir, '--output', output], {
      env: { ...process.env, OSM_API_TOKEN: 'test-token' } }).then(() => ({ code: 0, stderr: '' }),
      (error: { code: number; stderr: string }) => error);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Output file already exists/); assert.doesNotMatch(result.stderr, /secret-name/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('bundled CLI runs locally without executing a run step', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'osm-cli-'));
  try {
    await mkdir(join(dir, '.github/workflows'), { recursive: true });
    await writeFile(join(dir, '.github/workflows/ci.yml'), 'jobs:\n  build:\n    steps:\n      - run: exit 99\n');
    const result = await exec(process.execPath, [resolve('dist/cli.cjs'), '--path', dir], {
      env: { ...process.env, OSM_API_TOKEN: 'test-token' }
    });
    const report = JSON.parse(result.stdout);
    assert.equal(report.result, 'pass'); assert.equal(report.coverage.gaps, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
