import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { GitHub, LocalSource } from '../src/source.ts';
import { Http } from '../src/http.ts';
import type { Fetch } from '../src/http.ts';
const A = 'a'.repeat(40), T = 'b'.repeat(40);
const content = 'jobs: {}\n';
const blob = createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0${content}`).digest('hex');
function remote(options: { truncated?: boolean; mode?: string; content?: string; private?: boolean; name?: string; sha?: string } = {}) {
  const requests: string[] = [];
  const http = new Http((async (url) => {
    const path = new URL(String(url)).pathname; requests.push(path);
    let value: unknown;
    if (path.endsWith(`/commits/${A}`)) value = { sha: options.sha ?? A, commit: { tree: { sha: T } } };
    else if (path.endsWith(`/git/trees/${T}`)) value = { truncated: options.truncated ?? false,
      tree: [{ path: '.github/workflows/ci.yml', sha: blob, mode: options.mode ?? '100644', type: 'blob', size: 9 }] };
    else if (path.endsWith(`/git/blobs/${blob}`)) value = { encoding: 'base64', content: Buffer.from(options.content ?? content).toString('base64') };
    else if (path === '/repos/test/repo') value = { private: options.private ?? false, full_name: options.name ?? 'test/repo' };
    else throw new Error(`Unexpected path ${path}`);
    return new Response(JSON.stringify(value));
  }) as Fetch, async () => {});
  return { github: new GitHub('secret', http), requests };
}
test('remote trees are read at the commit tree and blob bytes are verified', async () => {
  const { github, requests } = remote();
  const { source } = await github.resolve('test/repo', A);
  assert.deepEqual(await source.workflows(), ['.github/workflows/ci.yml']);
  assert.equal(await source.read('.github/workflows/ci.yml'), content);
  assert.ok(requests.includes(`/repos/test/repo/git/trees/${T}`));
});
test('truncated trees, symlink blobs, or mismatched blob content fail closed', async t => {
  for (const opts of [{ truncated: true }, { mode: '120000' }, { content: 'changed' }]) {
    await t.test(JSON.stringify(opts), async () => {
      const { source } = await remote(opts).github.resolve('test/repo', A);
      await assert.rejects(source.read('.github/workflows/ci.yml'));
    });
  }
});
test('repository rename or different resolved commit is rejected', async () => {
  await assert.rejects(remote({ name: 'other/repo' }).github.resolve('test/repo', A));
  await assert.rejects(remote({ sha: T }).github.resolve('test/repo', A));
});
test('public/private visibility is explicitly established', async () => {
  assert.equal((await remote({ private: true }).github.resolve('test/repo', A)).private, true);
});
test('resolution returns GitHub canonical casing for intelligence lookups', async () => {
  assert.equal((await remote({ name: 'Test/Repo' }).github.resolve('test/repo', A)).name, 'Test/Repo');
});
test('local source rejects traversal, symlink directories, and oversized files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'osm-test-'));
  try {
    await mkdir(join(dir, '.github/workflows'), { recursive: true });
    await writeFile(join(dir, '.github/workflows/ci.yml'), content);
    await symlink(join(dir, '.github'), join(dir, 'linked'));
    await writeFile(join(dir, 'huge'), 'x'.repeat(512_001));
    const source = new LocalSource(dir);
    assert.equal(await source.read('.github/workflows/ci.yml'), content);
    assert.equal(await source.read('absent'), undefined);
    await assert.rejects(source.read('../escape'));
    await assert.rejects(source.read('linked/workflows/ci.yml'));
    await assert.rejects(source.read('huge'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
