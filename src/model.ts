export type ObjectValue = Record<string, unknown>;
export function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export const SHA = /^[a-f0-9]{40}$/i;
/** Validates an owner/repository identifier and preserves its casing. */
export function repositoryName(value: string): string {
  if (!/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(value) || value.split('/')[1] === '..') {
    throw new ScanError('Invalid GitHub owner/repository identifier');
  }
  return value;
}
/** Case-insensitive identity used for deduplication and report keys. */
export function repository(value: string): string {
  return repositoryName(value).toLowerCase();
}
export function filePath(value: string): string {
  const result = value.startsWith('./') ? value.slice(2) : value;
  if (!result || result.length > 1024 || /[\\\x00-\x1f\x7f]/.test(result) ||
      result.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new ScanError('Invalid repository-relative path');
  }
  return result;
}
export interface Location { source: string; file: string; line: number; chain: string[] }
export interface Finding extends Location {
  code: string; level: 'error' | 'warning'; message: string;
}
export interface Asset {
  repository: string; path: string; requestedRef: string; resolvedSha?: string;
  locations: Location[];
}
export interface Verdict {
  repository: string; state: 'no-verified-match' | 'flagged-repository' | 'error' | 'private';
  checkedAt: string; reportId?: string; reportUrl?: string;
}
export interface Report {
  schemaVersion: 1; scannerVersion: string; startedAt: string; finishedAt: string;
  target: string; scope: 'github-repository-intelligence';
  result: 'pass' | 'fail' | 'incomplete'; complete: boolean;
  assets: Asset[]; verdicts: Verdict[]; findings: Finding[];
  files: { source: string; path: string; sha256: string }[];
  coverage: { checkedRepositories: number; unresolved: number; gaps: number;
    exclusions: string[] };
}
/** Errors whose messages are fixed text written by this project and are safe to display. */
export class ScanError extends Error {
  constructor(message: string, public readonly status?: number) { super(message); }
}
const systemErrors: Record<string, string> = { EEXIST: 'Output file already exists',
  ENOENT: 'A required path does not exist', EACCES: 'Permission denied', EPERM: 'Permission denied' };
/** Describes an error without echoing upstream bodies, paths, or credentials. */
export function safeErrorMessage(error: unknown): string | undefined {
  if (error instanceof ScanError) return error.message;
  const code = object(error) || error instanceof Error ? (error as { code?: unknown }).code : undefined;
  if (typeof code !== 'string') return;
  if (code.startsWith('ERR_PARSE_ARGS_')) return 'Invalid command-line arguments';
  if (/^E[A-Z]+$/.test(code)) return systemErrors[code] ?? `System error ${code}`;
}
