import { readdir, lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { Http } from './http.ts';
import { filePath, object, repository, ScanError, SHA } from './model.ts';

export interface Source {
  id: string;
  workflows(): Promise<string[]>;
  read(path: string): Promise<string | undefined>;
}
export interface Resolver {
  resolve(repo: string, ref: string): Promise<{ source: Source; sha: string; private: boolean }>;
}
const MAX_FILE = 512_000;
export class LocalSource implements Source {
  readonly id = 'local';
  constructor(private readonly root: string) {}
  private async safe(path: string): Promise<string | undefined> {
    const base = await realpath(this.root);
    const parts = filePath(path).split('/');
    let cursor = base;
    for (const part of parts) {
      cursor = resolve(cursor, part);
      try {
        const stat = await lstat(cursor);
        if (stat.isSymbolicLink()) throw new ScanError('Symbolic links are not supported');
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    }
    const actual = await realpath(cursor);
    if (!actual.startsWith(base + sep)) throw new ScanError('Path escaped repository root');
    return actual;
  }
  async workflows(): Promise<string[]> {
    const dir = await this.safe('.github/workflows');
    if (!dir) return [];
    const items = await readdir(dir, { withFileTypes: true });
    if (items.length > 1000) throw new ScanError('Workflow count exceeds limit');
    return items.filter(x => /\.ya?ml$/.test(x.name)).map(x => `.github/workflows/${x.name}`).sort();
  }
  async read(path: string): Promise<string | undefined> {
    const safe = await this.safe(path);
    if (!safe) return;
    const handle = await open(safe, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE) throw new ScanError('File is not regular or exceeds size limit');
      const buffer = Buffer.alloc(MAX_FILE + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_FILE) throw new ScanError('File exceeds size limit');
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
    } finally { await handle.close(); }
  }
}

export class GitHub implements Resolver {
  private cache = new Map<string, Promise<{ source: Source; sha: string; private: boolean }>>();
  constructor(private readonly token: string, private readonly http = new Http()) {}
  async get(path: string): Promise<unknown> {
    return this.http.json(new URL(`https://api.github.com${path}`), this.token, 8_000_000);
  }
  resolve(repo: string, ref: string) {
    repo = repository(repo);
    if (!ref || ref.length > 256 || /[\x00-\x20\x7f]/.test(ref)) throw new ScanError('Invalid Git ref');
    const key = `${repo}@${ref}`;
    let result = this.cache.get(key);
    if (!result) {
      result = (async () => {
        const meta = await this.get(`/repos/${repo}`);
        if (!object(meta) || typeof meta.private !== 'boolean' || typeof meta.full_name !== 'string' ||
            repository(meta.full_name) !== repo) throw new ScanError('Repository identity is missing or redirected');
        const commit = await this.get(`/repos/${repo}/commits/${encodeURIComponent(ref)}`);
        if (!object(commit) || typeof commit.sha !== 'string' || !SHA.test(commit.sha)) throw new ScanError('Invalid commit response');
        const sha = commit.sha.toLowerCase();
        if (SHA.test(ref) && sha !== ref.toLowerCase()) throw new ScanError('Resolved commit did not match requested SHA');
        if (!object(commit.commit) || !object(commit.commit.tree) || typeof commit.commit.tree.sha !== 'string' || !SHA.test(commit.commit.tree.sha)) {
          throw new ScanError('Commit has no valid tree identity');
        }
        return { source: new GitHubSource(this, repo, sha, commit.commit.tree.sha), sha, private: meta.private };
      })();
      this.cache.set(key, result);
    }
    return result;
  }
}
class GitHubSource implements Source {
  readonly id: string;
  private tree?: Promise<Map<string, { sha: string; mode: string; size?: number }>>;
  constructor(private readonly github: GitHub, private readonly repo: string, sha: string, private readonly treeSha: string) {
    this.id = `${repo}@${sha}`;
  }
  private files() {
    this.tree ??= (async () => {
      const response = await this.github.get(`/repos/${this.repo}/git/trees/${this.treeSha}?recursive=1`);
      if (!object(response) || response.truncated !== false || !Array.isArray(response.tree)) throw new ScanError('Incomplete GitHub tree response');
      if (response.tree.length > 50_000) throw new ScanError('Repository tree exceeds limit');
      const files = new Map<string, { sha: string; mode: string; size?: number }>();
      for (const entry of response.tree) {
        if (!object(entry) || entry.type !== 'blob') continue;
        if (typeof entry.path !== 'string' || typeof entry.sha !== 'string' || !SHA.test(entry.sha) || typeof entry.mode !== 'string') {
          throw new ScanError('Malformed GitHub tree entry');
        }
        files.set(entry.path, { sha: entry.sha, mode: entry.mode, size: typeof entry.size === 'number' ? entry.size : undefined });
      }
      return files;
    })();
    return this.tree;
  }
  async workflows() { return [...(await this.files()).keys()].filter(x => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(x)).sort(); }
  async read(path: string): Promise<string | undefined> {
    const file = (await this.files()).get(filePath(path));
    if (!file) return;
    if (!['100644', '100755'].includes(file.mode) || (file.size ?? 0) > MAX_FILE) throw new ScanError('Unsafe or oversized Git blob');
    const blob = await this.github.get(`/repos/${this.repo}/git/blobs/${file.sha}`);
    if (!object(blob) || blob.encoding !== 'base64' || typeof blob.content !== 'string' || blob.content.length > MAX_FILE * 1.5) {
      throw new ScanError('Unsupported Git blob response');
    }
    const encoded = blob.content.replace(/\n/g, '');
    if (!/^[A-Za-z\d+/]*={0,2}$/.test(encoded) || encoded.length % 4) throw new ScanError('Invalid base64 Git blob');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > MAX_FILE) throw new ScanError('Git blob exceeds size limit');
    const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (hash !== file.sha) throw new ScanError('Git blob content does not match its identity');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
}
