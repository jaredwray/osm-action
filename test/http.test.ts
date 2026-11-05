import test from 'node:test';
import assert from 'node:assert/strict';
import { Http } from '../src/http.ts';
import type { Fetch } from '../src/http.ts';
import { OSM } from '../src/osm.ts';
const endpoint = new URL('https://api.opensourcemalware.com/functions/v1/check-malicious');
const json = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
const fake = (fn: (url: URL, init: RequestInit) => Response | Promise<Response>) => new Http(((url, init) => fn(new URL(String(url)), init!)) as Fetch, async () => {});
test('OSM uses an encoded canonical repository URL, fixed origin, and a header token', async () => {
  const provider = new OSM('secret', fake((url, init) => {
    assert.equal(url.origin, 'https://api.opensourcemalware.com');
    assert.equal(url.searchParams.get('resource_identifier'), 'https://github.com/Good/Action');
    assert.ok(!url.href.includes('secret')); assert.equal((init.headers as Record<string,string>).Authorization, 'Bearer secret');
    assert.equal(init.redirect, 'error');
    return json({ malicious: false, report_type: 'repository', resource_identifier: 'https://github.com/good/action' });
  }), async () => {}, 0);
  const verdict = await provider.check('Good/Action');
  assert.equal(verdict.state, 'no-verified-match'); assert.equal(verdict.repository, 'good/action');
});
test('positive results are repository-level and cached only within a run', async () => {
  let count = 0;
  const provider = new OSM('secret', fake(() => { count++; return json({ malicious: true, report_type: 'repository',
    resource_identifier: 'https://github.com/good/action', details: { status: 'verified' } }); }), async () => {}, 0);
  assert.equal((await provider.check('good/action')).state, 'flagged-repository');
  await provider.check('good/action'); assert.equal(count, 1);
});
test('missing token rejects before any request', () => assert.throws(() => new OSM(''), /required/));
test('missing Boolean or wrong identity rejects', async t => {
  for (const data of [{}, { malicious: 'false' }, { malicious: false, report_type: 'repository', resource_identifier: 'https://github.com/other/action' }]) {
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

test('a positive verdict without details is still flagged', async () => {
  const provider = new OSM('secret', fake(() => json({ malicious: true, report_type: 'repository',
    resource_identifier: 'https://github.com/good/action' })), async () => {}, 0);
  assert.equal((await provider.check('good/action')).state, 'flagged-repository');
});
test('documented threat_id and osm_url enrich flagged verdicts; foreign links are dropped', async t => {
  const id = '7c5a9372-a22a-49e8-9c68-6b634847d1c0';
  const url = 'https://opensourcemalware.com/repository/https%3A%2F%2Fgithub.com%2Fgood%2Faction';
  for (const [details, link, expectedUrl] of [[{ threat_id: id }, url, url], [{ id }, 'https://attacker.example/x', undefined],
    [{ threat_id: 'not-a-uuid' }, 'javascript:alert(1)', undefined]] as const) {
    await t.test(JSON.stringify(details), async () => {
      const verdict = await new OSM('secret', fake(() => json({ malicious: true, report_type: 'repository',
        resource_identifier: 'https://github.com/good/action', osm_url: link, details })), async () => {}, 0).check('good/action');
      assert.equal(verdict.reportId, 'threat_id' in details && details.threat_id === 'not-a-uuid' ? undefined : id);
      assert.equal(verdict.reportUrl, expectedUrl);
    });
  }
});
test('transient network errors are retried', async () => {
  let calls = 0;
  const http = fake(() => { if (++calls < 3) throw new Error('ECONNRESET'); return json({ ok: true }); });
  assert.deepEqual(await http.json(endpoint, 'secret'), { ok: true }); assert.equal(calls, 3);
});
test('throttling without Retry-After waits long enough to leave a per-minute window', async () => {
  let calls = 0; const delays: number[] = [];
  const http = new Http((async () => ++calls < 3 ? json({}, 429) : json({ ok: true })) as Fetch, async ms => { delays.push(ms); });
  assert.deepEqual(await http.json(endpoint, 'secret'), { ok: true }); assert.deepEqual(delays, [20_000, 40_000]);
});
test('GitHub 403 rate limits wait for reset within budget and explain exhaustion otherwise', async () => {
  const github = new URL('https://api.github.com/repos/a/b');
  let calls = 0; const delays: number[] = [];
  const reset = String(Math.ceil(Date.now() / 1000) + 5);
  const http = new Http((async () => ++calls === 1 ? json({}, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset })
    : json({ ok: true })) as Fetch, async ms => { delays.push(ms); });
  assert.deepEqual(await http.json(github, 'secret'), { ok: true });
  assert.ok(delays[0]! > 1000 && delays[0]! <= 6000);
  const later = String(Math.ceil(Date.now() / 1000) + 3600);
  await assert.rejects(fake(() => json({}, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': later })).json(github, 'secret'),
    /GitHub API rate limit exhausted/);
});
test('HTTP errors name the service and a safe hint', async () => {
  await assert.rejects(fake(() => json({ error: 'secret' }, 401)).json(endpoint, 'secret'),
    /^Error: OpenSourceMalware API returned HTTP 401 \(credentials were rejected\)$/);
});
