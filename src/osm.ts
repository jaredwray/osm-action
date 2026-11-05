import { Http, sleep } from './http.ts';
import type { Sleep } from './http.ts';
import { object, repository, repositoryName, ScanError } from './model.ts';
import type { Verdict } from './model.ts';
export interface Intelligence { check(repo: string): Promise<Verdict> }
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
/** Accepts only report links on OpenSourceMalware's own site. */
function reportUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'opensourcemalware.com' &&
        !url.username && !url.password && !url.port) return url.href;
  } catch { /* Malformed links are omitted. */ }
}
export class OSM implements Intelligence {
  private cache = new Map<string, Promise<Verdict>>();
  private nextRequest = 0;
  constructor(private readonly token: string, private readonly http = new Http(),
    private readonly pause: Sleep = sleep, private readonly intervalMs = 2100) {
    if (!token || /[\r\n]/.test(token)) throw new ScanError('OSM_API_TOKEN is required');
  }
  /** `name` should carry GitHub's canonical casing; deduplication is case-insensitive. */
  check(name: string): Promise<Verdict> {
    name = repositoryName(name);
    const key = repository(name);
    let cached = this.cache.get(key);
    if (!cached) { cached = this.lookup(key, name); this.cache.set(key, cached); }
    return cached;
  }
  private async lookup(key: string, name: string): Promise<Verdict> {
    // Called serially by the scanner; intentionally no persistent verdict cache.
    await this.pause(Math.max(0, this.nextRequest - Date.now()));
    this.nextRequest = Date.now() + this.intervalMs;
    // OSM does not document case-insensitive matching, so query the canonical form.
    const identifier = `https://github.com/${name}`;
    const url = new URL('https://api.opensourcemalware.com/functions/v1/check-malicious');
    url.searchParams.set('report_type', 'repository');
    url.searchParams.set('resource_identifier', identifier);
    const data = await this.http.json(url, this.token);
    if (!object(data) || typeof data.malicious !== 'boolean' || data.report_type !== 'repository' ||
        typeof data.resource_identifier !== 'string' ||
        data.resource_identifier.toLowerCase().replace(/\/$/, '') !== identifier.toLowerCase()) {
      throw new ScanError('OSM response does not match the repository lookup contract');
    }
    // A positive verdict stands on its own; details only enrich the report.
    const details = object(data.details) ? data.details : {};
    const reportId = [details.threat_id, details.id].find((x): x is string => typeof x === 'string' && UUID.test(x));
    const link = reportUrl(data.osm_url);
    return { repository: key, state: data.malicious ? 'flagged-repository' : 'no-verified-match',
      checkedAt: new Date().toISOString(), ...(reportId ? { reportId } : {}), ...(link ? { reportUrl: link } : {}) };
  }
}
