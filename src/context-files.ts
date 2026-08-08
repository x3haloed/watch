import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

const CONTEXT_FILE_MAX_CHARS = 20_000;
const CONTEXT_THREAT_PATTERNS: Array<[RegExp, string]> = [
  [/ignore\s+(previous|all|above|prior)\s+instructions/i, 'prompt_injection'],
  [/do\s+not\s+tell\s+the\s+user/i, 'deception_hide'],
  [/system\s+prompt\s+override/i, 'system_prompt_override'],
  [/disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, 'disregard_rules'],
  [/cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass)/i, 'read_secrets'],
];

const CONTEXT_INVISIBLE_CHARS = new Set(['\u200b', '\u200c', '\u200d', '\u2060', '\ufeff']);

export async function buildContextPrompt(repoRoot: string): Promise<string> {
  const root = resolve(repoRoot);
  const agents = await findFiles(root, 'AGENTS.md');
  const lowerAgents = await findFiles(root, 'agents.md');
  const files = [...agents, ...lowerAgents].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));

  if (files.length === 0) {
    return '';
  }

  const sections = [];
  for (const file of files) {
    const rel = relative(root, file) || file;
    const raw = (await readFile(file, 'utf8')).trim();
    if (!raw) continue;
    sections.push(`## ${rel}\n\n${sanitizeContext(raw, rel)}`);
  }

  if (sections.length === 0) {
    return '';
  }

  return `[repo_context]\n${truncate(sections.join('\n\n'), 'AGENTS.md')}\n[/repo_context]`;
}

async function findFiles(root: string, filename: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.watch') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && entry.name === filename) {
        out.push(path);
      }
    }
  }

  await walk(root);
  return out;
}

function sanitizeContext(content: string, filename: string): string {
  const findings = CONTEXT_THREAT_PATTERNS.filter(([pattern]) => pattern.test(content)).map(([, id]) => id);
  for (const char of CONTEXT_INVISIBLE_CHARS) {
    if (content.includes(char)) findings.push(`invisible_unicode_U+${char.charCodeAt(0).toString(16).toUpperCase()}`);
  }

  if (findings.length > 0) {
    return `[BLOCKED: ${filename} contained potential prompt injection (${findings.join(', ')}). Content not loaded.]`;
  }

  return content;
}

function truncate(content: string, filename: string): string {
  if (content.length <= CONTEXT_FILE_MAX_CHARS) return content;
  const headChars = Math.floor(CONTEXT_FILE_MAX_CHARS * 0.7);
  const tailChars = Math.floor(CONTEXT_FILE_MAX_CHARS * 0.2);
  return `${content.slice(0, headChars)}\n\n[...truncated ${filename}: kept ${headChars}+${tailChars} of ${content.length} chars. read_file returns the full file.]\n\n${content.slice(-tailChars)}`;
}

function depth(path: string): number {
  return path.split(sep).length;
}
