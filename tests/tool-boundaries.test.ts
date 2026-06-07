import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

test('tool modules do not use the old ctx:any escape hatch', async () => {
  const toolsDir = join(process.cwd(), 'src', 'tools');
  const files = (await readdir(toolsDir)).filter(file => file.endsWith('.ts'));
  const contents = await Promise.all(files.map(async file => [file, await readFile(join(toolsDir, file), 'utf8')] as const));

  for (const [file, content] of contents) {
    assert.doesNotMatch(content, /\bctx\s*:\s*any\b/, file);
    assert.doesNotMatch(content, /\bLookout\b/, file);
  }
});

test('lookout tool aggregator composes focused modules', async () => {
  const content = await readFile(join(process.cwd(), 'src', 'lookout-tools.ts'), 'utf8');

  assert.doesNotMatch(content, /jsonSchema/);
  assert.doesNotMatch(content, /\bctx\s*:\s*any\b/);
  assert.match(content, /createFileTools/);
  assert.match(content, /createSessionTools/);
  assert.match(content, /createStreamTools/);
});
