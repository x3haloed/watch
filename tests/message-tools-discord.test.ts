import test from 'node:test';
import assert from 'node:assert/strict';
import type { Sounding } from '../src/types.js';
import { createMessageTools } from '../src/tools/messages.js';
import type { LookoutToolContext } from '../src/tools/context.js';

test('send_message forwards proactive Discord channel targets', async () => {
  let captured: unknown;
  const tools = createMessageTools({
    cwd: '/tmp/watch-test',
    files: {} as never,
    terminal: {} as never,
    streams: {} as never,
    inbox: {} as never,
    models: {} as never,
    media: {} as never,
    skills: {} as never,
    session: {} as never,
    log: { append() {} } as never,
    discord: {
      sendMessage: async input => {
        captured = input;
        return { ok: true, delivered: 'discord', messages: [{ messageId: 'm1', channelId: 'c1', url: 'https://example.invalid' }] };
      },
    } as LookoutToolContext['discord'],
    scratchpad: undefined,
    messages: [],
    instructions: async () => '',
    contextFitFor: async () => ({ reason: 'test' } as never),
    currentModel: () => ({ id: 'model', provider: 'openai-compatible', model: 'model', capabilities: { tools: true, text: true, source: 'test' } } as never),
    switchModelForCurrentSounding: async () => ({ ok: true }),
    openMediaForModel: async () => ({ ok: true }),
  } as LookoutToolContext, {
    id: 'sounding-1',
    at: '2026-06-12T00:00:00.000Z',
    lastFlickerMs: 1000,
    trigger: 'manual',
    deltas: [],
    modelId: 'model',
    model: { id: 'model', provider: 'openai-compatible', model: 'model', capabilities: { tools: true, text: true, source: 'test' } } as never,
  } as Sounding);

  const sendMessage = tools.send_message as unknown as { execute: (input: { medium: string; message: string; channelId?: string }) => Promise<Record<string, unknown>> };
  const result = await sendMessage.execute({ medium: 'discord', channelId: '1234567890', message: 'hello there' });

  assert.equal(result.ok, true);
  assert.deepEqual(captured, { replyToId: undefined, channelId: '1234567890', message: 'hello there', attachments: undefined });
});
