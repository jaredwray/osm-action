import { Http, sleep } from './http.ts';
import type { Sleep } from './http.ts';
import { object, repository, ScanError } from './model.ts';
import type { Verdict } from './model.ts';
export interface Intelligence { check(repo: string): Promise<Verdict> }
export class OSM implements Intelligence {
  private cache = new Map<string, Promise<Verdict>>();
  private nextRequest = 0;
  constructor(private readonly token: string, private readonly http = new Http(),
    private readonly pause: Sleep = sleep, private readonly intervalMs = 2100) {
    if (!token || /[\r\n]/.test(token)) throw new ScanError('OSM_API_TOKEN is required');
  }
  check(repo: string): Promise<Verdict> {
    repo = repository(repo);
    let cached = this.cache.get(repo);
    if (!cached) { cached = this.lookup(repo); this.cache.set(repo, cached); }
    return cached;
  }
  private async lookup(repo: string): Promise<Verdict> {
    // Called serially by the scanner; intentionally no persistent verdict cache.
    await this.pause(Math.max(0, this.nextRequest - Date.now()));
    this.nextRequest = Date.now() + this.intervalMs;
    const identifier = `https://github.com/${repo}`;
    const url = new URL('https://api.opensourcemalware.com/functions/v1/check-malicious');
    url.searchParams.set('report_type', 'repository');
    url.searchParams.set('resource_identifier', identifier);
    const data = await this.http.json(url, this.token);
    if (!object(data) || typeof data.malicious !== 'boolean' || data.report_type !== 'repository' ||
        typeof data.resource_identifier !== 'string' || data.resource_identifier.toLowerCase().replace(/\/$/, '') !== identifier) {
      throw new ScanError('OSM response does not match the repository lookup contract');
    }
    if (data.malicious && !object(data.details)) throw new ScanError('OSM flagged response has no details object');
    return { repository: repo, state: data.malicious ? 'flagged-repository' : 'no-verified-match',
      checkedAt: new Date().toISOString(),
      ...(object(data.details) && typeof data.details.id === 'string' && /^[a-f\d-]{36}$/i.test(data.details.id)
        ? { reportId: data.details.id } : {}) };
  }
}
