export type ObjectValue = Record<string, unknown>;
export function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export const SHA = /^[a-f0-9]{40}$/i;
export function repository(value: string): string {
  if (!/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(value) || value.split('/')[1] === '..') {
    throw new Error('Invalid GitHub owner/repository identifier');
  }
  return value.toLowerCase();
}
export function filePath(value: string): string {
  const result = value.startsWith('./') ? value.slice(2) : value;
  if (!result || result.length > 1024 || /[\\\x00-\x1f\x7f]/.test(result) ||
      result.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error('Invalid repository-relative path');
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
  checkedAt: string; reportId?: string;
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
export class ScanError extends Error {
  constructor(message: string, public readonly status?: number) { super(message); }
}
