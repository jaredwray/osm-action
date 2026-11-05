import { ScanError } from './model.ts';
export type Fetch = typeof globalThis.fetch;
export type Sleep = (ms: number) => Promise<void>;
export const sleep: Sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ATTEMPTS = 3;
const MAX_RETRY_DELAY = 60_000;
const services: Record<string, string> = { 'api.github.com': 'GitHub', 'api.opensourcemalware.com': 'OpenSourceMalware' };
const statusHints: Record<number, string> = { 401: 'credentials were rejected', 403: 'access denied',
  404: 'not found or not accessible with the supplied token' };
/** A JSON write to the GitHub API. */
export interface Write { method: 'POST' | 'PATCH'; body: unknown }
export class Http {
  constructor(private readonly fetcher: Fetch = globalThis.fetch,
    private readonly pause: Sleep = sleep) {}

  async json(url: URL, token: string, limit = 2_000_000, write?: Write): Promise<unknown> {
    const service = services[url.hostname];
    if (url.protocol !== 'https:' || !service || url.username || url.password || url.port ||
        (write && service !== 'GitHub')) {
      throw new ScanError('Disallowed API destination');
    }
    // A POST that failed in transit or with 5xx may still have been applied, so only
    // throttled POSTs (rejected before processing) are retried.
    const replayable = write?.method !== 'POST';
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const final = attempt === ATTEMPTS - 1;
      const backoff = 1000 * 2 ** attempt;
      let response: Response;
      try {
        response = await this.fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(20_000),
          ...(write ? { method: write.method, body: JSON.stringify(write.body) } : {}),
          headers: { Accept: 'application/json', 'User-Agent': 'osm-action/0.1.0',
            ...(write ? { 'Content-Type': 'application/json' } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(url.hostname === 'api.github.com' ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}) } });
      } catch {
        // Connection resets and timeouts are usually transient.
        if (!final && replayable) { await this.pause(backoff); continue; }
        throw new ScanError(`${service} API request failed or timed out (details redacted)`);
      }
      let body: string;
      try { body = await read(response, limit); } catch (error) {
        if (error instanceof ScanError) throw error;
        if (!final && replayable) { await this.pause(backoff); continue; }
        throw new ScanError(`${service} API response could not be read`);
      }
      const remaining = response.headers.get('x-ratelimit-remaining');
      const retryAfter = response.headers.get('retry-after');
      // GitHub reports primary and secondary rate limits as 403 as well as 429.
      const githubLimited = service === 'GitHub' && response.status === 403 && (remaining === '0' || retryAfter !== null);
      const throttled = response.status === 429 || githubLimited;
      if ((throttled || (response.status >= 500 && replayable)) && !final) {
        if (response.status === 429 && /daily|24 hours|24-hour/i.test(body)) {
          throw new ScanError(`${service} API daily quota exhausted`, 429);
        }
        const ms = retryDelay(retryAfter, githubLimited && remaining === '0' ? response.headers.get('x-ratelimit-reset') : null,
          // OSM documents a per-minute window without Retry-After; short waits would retry into the same window.
          throttled ? 20_000 * 2 ** attempt : backoff);
        if (!Number.isFinite(ms) || ms > MAX_RETRY_DELAY) {
          throw new ScanError(githubLimited ? 'GitHub API rate limit exhausted; supply a GitHub token or retry later'
            : `${service} API retry delay exceeds scan budget`, response.status);
        }
        await this.pause(Math.max(1000, ms));
        continue;
      }
      if (!response.ok) {
        const hint = statusHints[response.status];
        throw new ScanError(`${service} API returned HTTP ${response.status}${hint ? ` (${hint})` : ''}`, response.status);
      }
      try { return JSON.parse(body); } catch { throw new ScanError(`${service} API returned invalid JSON`); }
    }
    throw new ScanError(`${service} API retries exhausted`);
  }
}
async function read(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) for (;;) {
    const item = await reader.read();
    if (item.done) break;
    bytes += item.value.byteLength;
    if (bytes > limit) { await reader.cancel(); throw new ScanError('API response exceeded size limit'); }
    chunks.push(item.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
/** Milliseconds to wait, from Retry-After, a rate-limit reset epoch, or the fallback. */
function retryDelay(retryAfter: string | null, resetEpoch: string | null, fallback: number): number {
  if (retryAfter !== null && retryAfter.trim()) {
    const seconds = Number(retryAfter);
    return Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
  }
  if (resetEpoch !== null) return Number(resetEpoch) * 1000 - Date.now();
  return fallback;
}
