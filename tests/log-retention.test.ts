import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../src/event-log.js';
import { InferenceForensics } from '../src/inference-forensics.js';

test('EventLog rotates events by size and keeps current tail', () => {
  const instanceRoot = mkdtempSync(join(tmpdir(), 'watch-instance-'));
  try {
    const log = new EventLog(instanceRoot, { maxBytes: 120, maxArchives: 2 });
    log.append({ type: 'daemon_stopped', at: 't1', pid: 1, reason: 'x'.repeat(100) });
    log.append({ type: 'daemon_stopped', at: 't2', pid: 1, reason: 'after rotation' });

    const archiveDir = join(instanceRoot, 'logs', 'archive');
    const archives = readdirSync(archiveDir).filter(name => name.endsWith('.jsonl'));
    assert.equal(archives.length, 1);
    assert.equal(log.tail(10).at(-1)?.type, 'daemon_stopped');
    assert.equal(existsSync(join(instanceRoot, 'logs', 'events.jsonl')), true);
  } finally {
    rmSync(instanceRoot, { recursive: true, force: true });
  }
});

test('InferenceForensics prunes oldest model request snapshots', () => {
  const instanceRoot = mkdtempSync(join(tmpdir(), 'watch-instance-'));
  const previousMaxFiles = process.env.WATCH_MODEL_REQUEST_MAX_FILES;
  const previousMaxBytes = process.env.WATCH_MODEL_REQUEST_MAX_BYTES;
  process.env.WATCH_MODEL_REQUEST_MAX_FILES = '2';
  process.env.WATCH_MODEL_REQUEST_MAX_BYTES = '0';

  try {
    const forensics = new InferenceForensics(instanceRoot, 'sounding-1');
    const record = forensics.recorder();
    record({ messages: [{ role: 'user', content: 'one' }] }, { provider: 'test', modelId: 'm1', providerModel: 'pm1' });
    record({ messages: [{ role: 'user', content: 'two' }] }, { provider: 'test', modelId: 'm1', providerModel: 'pm1' });
    record({ messages: [{ role: 'user', content: 'three' }] }, { provider: 'test', modelId: 'm1', providerModel: 'pm1' });

    const files = readdirSync(join(instanceRoot, 'logs', 'model-requests')).filter(name => name.endsWith('.json')).sort();
    assert.deepEqual(files, ['sounding-1-002.json', 'sounding-1-003.json']);
  } finally {
    if (previousMaxFiles === undefined) {
      delete process.env.WATCH_MODEL_REQUEST_MAX_FILES;
    } else {
      process.env.WATCH_MODEL_REQUEST_MAX_FILES = previousMaxFiles;
    }
    if (previousMaxBytes === undefined) {
      delete process.env.WATCH_MODEL_REQUEST_MAX_BYTES;
    } else {
      process.env.WATCH_MODEL_REQUEST_MAX_BYTES = previousMaxBytes;
    }
    rmSync(instanceRoot, { recursive: true, force: true });
  }
});
