import { constants } from 'node:fs';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class RepoFileTools {
  constructor(private readonly repoRoot: string) {}

  async readFile(path: string, offset = 1, limit = 500): Promise<Record<string, unknown>> {
    const file = this.resolveInsideRepo(path);
    const content = await readFile(file, 'utf8');
    const lines = content.split(/\r?\n/);
    const start = Math.max(1, Math.floor(offset));
    const count = Math.max(1, Math.min(1000, Math.floor(limit)));
    const selected = lines.slice(start - 1, start - 1 + count);

    return {
      ok: true,
      path: this.displayPath(file),
      offset: start,
      limit: count,
      totalLines: lines.length,
      hasMore: start - 1 + count < lines.length,
      content: selected.map((line, index) => `${start + index}: ${line}`).join('\n'),
    };
  }

  async writeFile(path: string, content: string, overwrite = false): Promise<Record<string, unknown>> {
    const file = this.resolveInsideRepo(path);
    if ((await exists(file)) && !overwrite) {
      return {
        ok: false,
        error: 'File already exists. Use patch for edits/appends, or call write_file with overwrite=true only when intentionally replacing the entire file.',
        path: this.displayPath(file),
      };
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
    return { ok: true, path: this.displayPath(file), bytes: Buffer.byteLength(content, 'utf8'), overwritten: overwrite };
  }

  async searchFiles(input: {
    pattern: string;
    target?: 'content' | 'files';
    path?: string;
    fileGlob?: string;
    limit?: number;
  }): Promise<Record<string, unknown>> {
    const targetPath = this.resolveInsideRepo(input.path ?? '.');
    const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));

    if (input.target === 'files') {
      const { stdout } = await execFileAsync('rg', ['--files', targetPath], { cwd: this.repoRoot, maxBuffer: 1024 * 1024 * 8 });
      const matches = stdout
        .split('\n')
        .filter(Boolean)
        .filter(path => path.includes(input.pattern))
        .slice(0, limit)
        .map(path => this.displayPath(resolve(path)));
      return { ok: true, matches, count: matches.length, truncated: matches.length === limit };
    }

    const args = ['--line-number', '--column', '--no-heading', '--color', 'never'];
    if (input.fileGlob?.trim()) args.push('--glob', input.fileGlob);
    args.push(input.pattern, targetPath);

    try {
      const { stdout } = await execFileAsync('rg', args, { cwd: this.repoRoot, maxBuffer: 1024 * 1024 * 8 });
      const matches = stdout
        .split('\n')
        .filter(Boolean)
        .slice(0, limit)
        .map(line => line.replace(this.repoRoot + sep, ''));
      return { ok: true, matches, count: matches.length, truncated: matches.length === limit };
    } catch (error) {
      if (isNoMatches(error)) return { ok: true, matches: [], count: 0, truncated: false };
      throw error;
    }
  }

  async patch(path: string, oldString: string, newString: string, replaceAll = false): Promise<Record<string, unknown>> {
    const file = this.resolveInsideRepo(path);
    const content = await readFile(file, 'utf8');
    const count = countOccurrences(content, oldString);
    if (oldString.length === 0) {
      return { ok: false, error: 'old_string cannot be empty' };
    }
    if (count === 0) {
      return { ok: false, error: 'old_string not found', path: this.displayPath(file) };
    }
    if (count > 1 && !replaceAll) {
      return { ok: false, error: 'old_string matched multiple times; set replace_all true to replace all matches', matches: count };
    }

    const updated = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
    await writeFile(file, updated, 'utf8');
    return { ok: true, path: this.displayPath(file), replacements: replaceAll ? count : 1 };
  }

  private resolveInsideRepo(path: string): string {
    const root = resolve(this.repoRoot);
    const resolved = resolve(root, path);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw new Error(`Path escapes repo root: ${path}`);
    }
    return resolved;
  }

  private displayPath(path: string): string {
    const rel = relative(resolve(this.repoRoot), path);
    return rel || '.';
  }
}

export async function assertReadableRepo(repoRoot: string): Promise<void> {
  await access(repoRoot, constants.R_OK);
  const stats = await stat(repoRoot);
  if (!stats.isDirectory()) {
    throw new Error(`repoRoot is not a directory: ${repoRoot}`);
  }
}

function countOccurrences(content: string, search: string): number {
  if (!search) return 0;
  let count = 0;
  let index = 0;
  while ((index = content.indexOf(search, index)) !== -1) {
    count += 1;
    index += search.length;
  }
  return count;
}

function isNoMatches(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 1;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
