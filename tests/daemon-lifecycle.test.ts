import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DaemonLifecycleStore, redactDiagnosticText } from '../src/daemon-lifecycle.js';

test('daemon lifecycle exposes an unobserved previous exit and preserves clean stops', () => {
  const root = mkdtempSync(join(tmpdir(), 'watch-lifecycle-'));
  try {
    const first = new DaemonLifecycleStore(root);
    first.begin(10, '2026-01-01T00:00:00.000Z');
    first.heartbeat('2026-01-01T00:00:30.000Z');

    const second = new DaemonLifecycleStore(root);
    const crossing = second.begin(20, '2026-01-01T00:01:00.000Z');
    assert.equal(crossing.previous?.pid, 10);
    assert.equal(crossing.previous?.lastHeartbeatAt, '2026-01-01T00:00:30.000Z');
    second.stop('control request', '2026-01-01T00:01:30.000Z');

    const third = new DaemonLifecycleStore(root).begin(30, '2026-01-01T00:02:00.000Z');
    assert.equal(third.previous, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fatal diagnostics are bounded and redact common credentials', () => {
  const value = redactDiagnosticText(`Bearer secret https://x.test/?token=abc sk_abcdefghijklmnop ${'x'.repeat(3_000)}`);
  assert.ok(value.length <= 2_000);
  assert.doesNotMatch(value, /secret|token=abc|sk_abcdefghijklmnop/);
});
