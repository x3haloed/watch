import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

type SkillRecord = {
  name: string;
  description: string;
  path: string;
  root: string;
  file: string;
  directory: string;
  category?: string;
};

export type SkillSummary = Pick<SkillRecord, 'name' | 'description' | 'path' | 'category'>;

export class SkillLibrary {
  private readonly roots: string[];

  constructor(repoRoot: string) {
    this.roots = [join(repoRoot, '.agents', 'skills'), join(repoRoot, 'skills')];
  }

  async list(category?: string): Promise<Record<string, unknown>> {
    const skills = await this.summaries(category);
    const filtered = category ? skills.filter(skill => skill.category === category) : skills;
    const categories = Array.from(new Set(filtered.map(skill => skill.category).filter(Boolean))).sort();
    return {
      ok: true,
      skills: filtered.map(({ name, description, category, path }) => ({ name, description, category, path })),
      categories,
      count: filtered.length,
      hint: 'Use skill_view with a skill name to load full instructions, or with file_path to load a linked file.',
    };
  }

  async summaries(category?: string): Promise<SkillSummary[]> {
    const skills = await this.findAll();
    return (category ? skills.filter(skill => skill.category === category) : skills).map(
      ({ name, description, category: skillCategory, path }) => ({
        name,
        description,
        category: skillCategory,
        path,
      }),
    );
  }

  async view(name: string, filePath?: string): Promise<Record<string, unknown>> {
    const skills = await this.findAll();
    const skill = skills.find(candidate => candidate.name === name || basename(candidate.directory) === name || candidate.path === name);
    if (!skill) {
      return {
        ok: false,
        error: `Skill not found: ${name}`,
        availableSkills: skills.slice(0, 20).map(candidate => candidate.name),
      };
    }

    if (filePath?.trim()) {
      const target = resolve(skill.directory, filePath);
      if (target !== skill.directory && !target.startsWith(skill.directory + sep)) {
        return { ok: false, error: 'Path escapes skill directory boundary.' };
      }
      try {
        const content = await readFile(target, 'utf8');
        return { ok: true, name: skill.name, file: filePath, content, fileType: target.split('.').pop() ?? '' };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          availableFiles: await this.linkedFiles(skill.directory),
        };
      }
    }

    const content = await readFile(skill.file, 'utf8');
    return {
      ok: true,
      name: skill.name,
      description: skill.description,
      content,
      path: skill.path,
      linkedFiles: await this.linkedFiles(skill.directory),
    };
  }

  private async findAll(): Promise<SkillRecord[]> {
    const all: SkillRecord[] = [];
    for (const root of this.roots) {
      all.push(...(await this.findUnderRoot(root)));
    }
    return all.sort((a, b) => (a.category ?? '').localeCompare(b.category ?? '') || a.name.localeCompare(b.name));
  }

  private async findUnderRoot(root: string): Promise<SkillRecord[]> {
    const resolvedRoot = resolve(root);
    if (!(await existsDirectory(resolvedRoot))) return [];

    const files: string[] = [];
    async function walk(dir: string): Promise<void> {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        if (entry.isFile() && entry.name === 'SKILL.md') files.push(full);
      }
    }

    await walk(resolvedRoot);

    const skills: SkillRecord[] = [];
    for (const file of files) {
      const content = (await readFile(file, 'utf8')).slice(0, 4000);
      const { frontmatter, body } = parseFrontmatter(content);
      const directory = dirname(file);
      const rel = relative(resolvedRoot, file);
      const parts = rel.split(sep);
      const category = parts.length > 2 ? parts[0] : undefined;
      skills.push({
        name: asString(frontmatter.name) || basename(directory),
        description: asString(frontmatter.description) || firstBodyLine(body),
        path: rel,
        root: resolvedRoot,
        file,
        directory,
        category,
      });
    }
    return skills;
  }

  private async linkedFiles(skillDir: string): Promise<Record<string, string[]> | undefined> {
    const buckets: Record<string, string[]> = {};
    async function walk(dir: string): Promise<void> {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && entry.name !== 'SKILL.md') {
          const rel = relative(skillDir, full);
          const bucket = rel.split(sep)[0] || 'other';
          buckets[bucket] ??= [];
          buckets[bucket].push(rel);
        }
      }
    }
    await walk(skillDir);
    return Object.keys(buckets).length ? buckets : undefined;
  }
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!content.startsWith('---')) return { frontmatter: {}, body: content };
  const match = /\n---\s*\n/.exec(content.slice(3));
  if (!match) return { frontmatter: {}, body: content };
  const yaml = content.slice(3, match.index + 3);
  const body = content.slice(match.index + match[0].length + 3);
  const frontmatter: Record<string, unknown> = {};
  for (const line of yaml.split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key) frontmatter[key] = value;
  }
  return { frontmatter, body };
}

async function existsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 1024) : '';
}

function firstBodyLine(body: string): string {
  return body
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line && !line.startsWith('#'))
    ?.slice(0, 1024) ?? '';
}
