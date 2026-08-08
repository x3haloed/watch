import assert from 'node:assert/strict';
import test from 'node:test';
import { daemonRestartPlan } from '../src/server.js';

test('systemd-managed reboot delegates replacement to the supervisor', () => {
  assert.deepEqual(daemonRestartPlan({ INVOCATION_ID: 'systemd-invocation' }), {
    spawnReplacement: false,
    exitCode: 75,
  });
});

test('unsupervised reboot retains detached self-replacement', () => {
  assert.deepEqual(daemonRestartPlan({}), {
    spawnReplacement: true,
    exitCode: 0,
  });
});
