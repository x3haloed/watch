import assert from 'node:assert/strict';
import test from 'node:test';
import { discordPresenceEnabled, discordPresencePayload } from '../src/discord.js';
import { deriveResidentPresence, isToolActivityEvent } from '../src/presence.js';

test('resident presence follows runtime priority', () => {
  assert.deepEqual(deriveResidentPresence({ running: false, soundingActive: false, soundQueued: false }), { state: 'offline', label: 'Offline', tone: 'error' });
  assert.deepEqual(deriveResidentPresence({ running: true, soundingActive: false, soundQueued: false }), { state: 'ready', label: 'Ready', tone: 'ok' });
  assert.deepEqual(deriveResidentPresence({ running: true, soundingActive: false, soundQueued: true }), { state: 'queued', label: 'Queued', tone: 'pending' });
  assert.deepEqual(deriveResidentPresence({ running: true, soundingActive: true, soundQueued: false }), { state: 'thinking', label: 'Thinking', tone: 'thinking' });
  assert.deepEqual(deriveResidentPresence({ running: true, soundingActive: true, soundQueued: false }, true), { state: 'using_tools', label: 'Using tools', tone: 'tool' });
});

test('Watch model and terminal events identify tool activity', () => {
  assert.equal(isToolActivityEvent({ type: 'model_step_finished', at: 'now', soundingId: 's', modelId: 'm', step: { content: [{ type: 'tool-call' }] } }), true);
  assert.equal(isToolActivityEvent({ type: 'terminal_started', at: 'now', soundingId: 's', sessionId: 'x', command: 'pwd', cwd: '/', background: false, pty: false }), true);
  assert.equal(isToolActivityEvent({ type: 'model_step_finished', at: 'now', soundingId: 's', modelId: 'm', step: { text: 'hello' } }), false);
});

test('Discord projection is independently configurable', () => {
  assert.equal(discordPresenceEnabled({ enabled: true, presenceEnabled: false }), false);
  assert.equal(discordPresenceEnabled({ enabled: true }), true);
  assert.equal(discordPresencePayload({ state: 'ready', label: 'Ready', tone: 'ok' }).status, 'online');
  assert.equal(discordPresencePayload({ state: 'thinking', label: 'Thinking', tone: 'thinking' }).status, 'dnd');
});
