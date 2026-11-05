import { ScanError } from './model.ts';
export type Fetch = typeof globalThis.fetch;
export type Sleep = (ms: number) => Promise<void>;
export const sleep: Sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export class Http {
  constructor(private readonly fetcher: Fetch = globalThis.fetch,
    private readonly pause: Sleep = sleep) {}

  async json(url: URL, token: string, limit = 2_000_000): Promise<unknown> {
    if (url.protocol !== 'https:' || !['api.github.com', 'api.opensourcemalware.com'].includes(url.hostname) ||
        url.username || url.password || url.port) throw new ScanError('Disallowed API destination');
    for (let attempt = 0; attempt < 3; attempt++) {
      const signal = AbortSignal.timeout(20_000);
      let response: Response;
      try {
        response = await this.fetcher(url, { redirect: 'error', signal,
          headers: { Accept: 'application/json', 'User-Agent': 'osm-action/0.1.0',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(url.hostname === 'api.github.com' ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}) } });
      } catch { throw new ScanError('API request failed or timed out (details redacted)'); }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        if (reader) for (;;) {
          const item = await reader.read();
          if (item.done) break;
          bytes += item.value.byteLength;
          if (bytes > limit) { await reader.cancel(); throw new ScanError('API response exceeded size limit'); }
          chunks.push(item.value);
        }
      } catch (error) {
        if (error instanceof ScanError) throw error;
        throw new ScanError('API response could not be read');
      }
      const body = Buffer.concat(chunks).toString('utf8');
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        if (response.status === 429 && /daily|24 hours|24-hour/i.test(body)) {
          throw new ScanError('API daily quota exhausted', 429);
        }
        const retry = response.headers.get('retry-after');
        const numeric = retry === null ? NaN : Number(retry);
        const ms = Number.isFinite(numeric) ? numeric * 1000 : retry ? Date.parse(retry) - Date.now() : 1000 * 2 ** attempt;
        if (!Number.isFinite(ms) || ms > 60_000) throw new ScanError('API retry delay exceeds scan budget', response.status);
        await this.pause(Math.max(1000, ms));
        continue;
      }
      if (!response.ok) throw new ScanError(`API returned HTTP ${response.status}`, response.status);
      try { return JSON.parse(body); } catch { throw new ScanError('API returned invalid JSON'); }
    }
    throw new ScanError('API retries exhausted');
  }
}
