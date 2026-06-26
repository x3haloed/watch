import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export type FileRetentionOptions = {
  maxBytes?: number;
  maxFiles?: number;
  maxArchives?: number;
  archiveDir?: string;
  extension?: string;
  envPrefix?: string;
};

export function rotateFileIfNeeded(path: string, options: FileRetentionOptions = {}): void {
  const maxBytes = optionNumber(options.maxBytes, optionEnv(options.envPrefix, 'MAX_BYTES'), 25 * 1024 * 1024);
  if (maxBytes <= 0 || fileSize(path) < maxBytes) {
    return;
  }

  const archiveDir = options.archiveDir ?? join(dirname(path), 'archive');
  mkdirSync(archiveDir, { recursive: true });
  const stamp = timestampForFilename();
  const ext = options.extension ?? extensionFor(path);
  const archivePath = join(archiveDir, `${basename(path, ext)}.${stamp}${ext}`);
  renameSync(path, archivePath);
  pruneFiles(archiveDir, {
    maxFiles: optionNumber(options.maxArchives, optionEnv(options.envPrefix, 'MAX_ARCHIVES'), 10),
    extension: ext,
  });
}

export function pruneFiles(dir: string, options: FileRetentionOptions = {}): void {
  if (!existsSync(dir)) {
    return;
  }

  const maxFiles = optionNumber(options.maxFiles, optionEnv(options.envPrefix, 'MAX_FILES'), -1);
  const maxBytes = optionNumber(options.maxBytes, optionEnv(options.envPrefix, 'MAX_BYTES'), -1);
  if (maxFiles < 0 && maxBytes <= 0) {
    return;
  }

  const files = readdirSync(dir)
    .filter(name => !options.extension || name.endsWith(options.extension))
    .map(name => {
      const path = join(dir, name);
      const stat = statSync(path);
      return stat.isFile() ? { name, path, mtime: stat.mtimeMs, size: stat.size } : undefined;
    })
    .filter((entry): entry is { name: string; path: string; mtime: number; size: number } => Boolean(entry))
    .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));

  let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  for (const [index, file] of files.entries()) {
    const overFileLimit = maxFiles >= 0 && index >= maxFiles;
    const overByteLimit = maxBytes > 0 && totalBytes > maxBytes;
    if (!overFileLimit && !overByteLimit) {
      continue;
    }
    unlinkSync(file.path);
    totalBytes -= file.size;
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function optionNumber(value: number | undefined, envName: string | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (envName && process.env[envName]) {
    const parsed = Number(process.env[envName]);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function optionEnv(prefix: string | undefined, suffix: string): string | undefined {
  return prefix ? `${prefix}_${suffix}` : undefined;
}

function extensionFor(path: string): string {
  const dot = basename(path).lastIndexOf('.');
  return dot === -1 ? '' : basename(path).slice(dot);
}

function timestampForFilename(): string {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}
