import test from 'node:test';
import assert from 'node:assert/strict';
import { Http } from '../src/http.ts';
import type { Fetch } from '../src/http.ts';
import { OSM } from '../src/osm.ts';
const endpoint = new URL('https://api.opensourcemalware.com/functions/v1/check-malicious');
const json = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
const fake = (fn: (url: URL, init: RequestInit) => Response | Promise<Response>) => new Http(((url, init) => fn(new URL(String(url)), init!)) as Fetch, async () => {});
test('OSM uses an encoded repository URL, fixed origin, and a header token', async () => {
  const provider = new OSM('secret', fake((url, init) => {
    assert.equal(url.origin, 'https://api.opensourcemalware.com');
    assert.equal(url.searchParams.get('resource_identifier'), 'https://github.com/good/action');
    assert.ok(!url.href.includes('secret')); assert.equal((init.headers as Record<string,string>).Authorization, 'Bearer secret');
    assert.equal(init.redirect, 'error');
    return json({ malicious: false, report_type: 'repository', resource_identifier: 'https://github.com/good/action' });
  }), async () => {}, 0);
  assert.equal((await provider.check('Good/Action')).state, 'no-verified-match');
});
test('positive results are repository-level and cached only within a run', async () => {
  let count = 0;
  const provider = new OSM('secret', fake(() => { count++; return json({ malicious: true, report_type: 'repository',
    resource_identifier: 'https://github.com/good/action', details: { status: 'verified' } }); }), async () => {}, 0);
  assert.equal((await provider.check('good/action')).state, 'flagged-repository');
  await provider.check('good/action'); assert.equal(count, 1);
});
test('missing token rejects before any request', () => assert.throws(() => new OSM(''), /required/));
test('missing Boolean, wrong identity, or missing positive details rejects', async t => {
  for (const data of [{}, { malicious: 'false' }, { malicious: false, report_type: 'repository', resource_identifier: 'https://github.com/other/action' },
    { malicious: true, report_type: 'repository', resource_identifier: 'https://github.com/good/action' }]) {
    await t.test(JSON.stringify(data), async () => assert.rejects(new OSM('secret', fake(() => json(data)), async () => {}, 0).check('good/action')));
  }
});
test('daily exhaustion is not retried', async () => {
  let calls = 0;
  await assert.rejects(fake(() => { calls++; return json({ error: 'Daily quota exceeded' }, 429); }).json(endpoint, 'secret'), /daily quota/);
  assert.equal(calls, 1);
});
test('temporary throttling is retried with a bounded delay', async () => {
  let calls = 0; const delays: number[] = [];
  const http = new Http((async () => ++calls === 1 ? json({}, 429, { 'Retry-After': '2' }) : json({ ok: true })) as Fetch,
    async ms => { delays.push(ms); });
  assert.deepEqual(await http.json(endpoint, 'secret'), { ok: true }); assert.deepEqual(delays, [2000]);
});
test('long retry delays are not ignored or shortened', async () => {
  await assert.rejects(fake(() => json({}, 429, { 'Retry-After': '3600' })).json(endpoint, 'secret'), /budget/);
});
test('401 and 403 fail immediately without reflecting the response body', async t => {
  for (const status of [401, 403]) await t.test(String(status), async () => {
    let calls = 0;
    await assert.rejects(fake(() => { calls++; return json({ error: 'secret' }, status); }).json(endpoint, 'secret'),
      error => error instanceof Error && !error.message.includes('secret'));
    assert.equal(calls, 1);
  });
});
test('invalid JSON and oversized bodies reject', async () => {
  await assert.rejects(fake(() => new Response('{')).json(endpoint, ''), /invalid JSON/);
  await assert.rejects(fake(() => new Response('123456')).json(endpoint, '', 3), /size limit/);
});
test('untrusted origins, credentials in URLs, and redirects are refused', async () => {
  let calls = 0; const http = fake(() => { calls++; return json({}); });
  for (const url of ['https://attacker.example/', 'http://api.github.com/', 'https://user:pw@api.github.com/', 'https://api.github.com:444/']) {
    await assert.rejects(http.json(new URL(url), 'secret'), /Disallowed/);
  }
  assert.equal(calls, 0);
  await assert.rejects(fake(() => new Response('', { status: 302, headers: { Location: 'https://attacker.example/' } })).json(endpoint, 'secret'), /302/);
});
test('network errors are redacted', async () => {
  await assert.rejects(fake(() => { throw new Error('secret'); }).json(endpoint, 'secret'),
    error => error instanceof Error && !error.message.includes('secret'));
});
