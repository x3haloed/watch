import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EventLog } from '../src/event-log.js';
import { Lookout } from '../src/lookout.js';
import { ModelRegistry } from '../src/model-registry.js';
import { StreamRegistry } from '../src/streams.js';
import type { Sounding } from '../src/types.js';

// Exercise Watch's actual agent, provider adapter, tools, and history against
// deterministic Chat Completions responses, without credentials or inference.
for (const interrupted of [false, true]) {
  test(`agent preserves every completed tool step ${interrupted ? 'after interruption' : 'across soundings'}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'watch-agent-'));
    const originalFetch = globalThis.fetch;
    const requests: Array<{ messages: Array<Record<string, any>> }> = [];
    t.after(() => {
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    });
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      models: {
        'local:test': {
          provider: 'openai-compatible', model: 'test', baseURL: 'http://watch.test/v1',
          capabilities: { tools: true, text: true, images: true, contextTokens: 200000, outputTokens: 1000 },
        },
      },
    }));
    writeFileSync(join(root, 'evidence.txt'), 'migration evidence');
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'http://watch.test/v1/chat/completions');
      requests.push(JSON.parse(String(init?.body)));
      const step = requests.length;
      if (interrupted && step === 3) {
        return Response.json({ error: { message: 'invalid continuation' } }, { status: 400 });
      }
      const toolCall = step <= 2;
      return Response.json({
        id: `response-${step}`, object: 'chat.completion', created: 0, model: 'test',
        choices: [{ index: 0, finish_reason: toolCall ? 'tool_calls' : 'stop', message: toolCall
          ? { role: 'assistant', content: null, tool_calls: [{
              id: `call-${step}`, type: 'function',
              function: { name: 'read_file', arguments: JSON.stringify({ path: 'evidence.txt' }) },
            }] }
          : { role: 'assistant', content: 'done' },
        }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      });
    };
    const registry = ModelRegistry.load(root, 'local:test');
    const model = await registry.getActive();
    const log = new EventLog(root);
    const streams = new StreamRegistry([], root);
    t.after(() => streams.stop());
    const lookout = new Lookout(streams, log, registry, false, root);
    const sounding: Sounding = {
      id: 'first', at: new Date().toISOString(), lastFlickerMs: 1000,
      trigger: 'delta', modelId: model.id, model,
      deltas: [{ stream: 'inbox', at: new Date().toISOString(), payload: { text: 'read evidence twice' } }],
    };
    if (interrupted) {
      await assert.rejects(lookout.receive(sounding), /invalid continuation/);
    } else {
      assert.deepEqual(await lookout.receive(sounding), { text: 'done', toolCallCount: 2 });
    }
    assert.deepEqual(await lookout.receive({ ...sounding, id: 'next' }), { text: 'done', toolCallCount: 0 });
    const history = requests.at(-1)!.messages;
    for (const id of ['call-1', 'call-2']) {
      const calls = history.flatMap(message => message.tool_calls ?? []).filter(call => call.id === id);
      const results = history.filter(message => message.role === 'tool' && message.tool_call_id === id);
      assert.equal(calls.length, 1, `${id} must appear once`);
      assert.equal(results.length, 1, `${id} result must appear once`);
      assert.match(results[0].content, /migration evidence/);
    }
    assert.equal(log.tail().filter(event => event.type === 'model_step_finished').length, interrupted ? 3 : 4);
    if (interrupted) {
      assert.ok(history.some(message => typeof message.content === 'string' && message.content.includes('[model_failure_trace]')));
    }
    assert.equal(existsSync(join(root, 'memory')), false);
  });
}

test('agent restores tool images when switching back from a text-only model', async t => {
  const root = mkdtempSync(join(tmpdir(), 'watch-agent-media-'));
  const originalFetch = globalThis.fetch;
  const requests: Array<{ model: string; messages: Array<Record<string, any>> }> = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  });
  const capabilities = { tools: true, text: true, contextTokens: 200000, outputTokens: 1000 };
  writeFileSync(join(root, 'config.json'), JSON.stringify({ models: {
    'local:vision': {
      provider: 'openai-compatible', model: 'vision', baseURL: 'http://watch.test/v1',
      capabilities: { ...capabilities, images: true },
    },
    'local:text': {
      provider: 'openai-compatible', model: 'text', baseURL: 'http://watch.test/v1',
      capabilities: { ...capabilities, images: false },
    },
  } }));
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
  writeFileSync(join(root, 'pixel.png'), Buffer.from(image, 'base64'));
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'http://watch.test/v1/chat/completions');
    requests.push(JSON.parse(String(init?.body)));
    const step = requests.length;
    const call = step === 1
      ? { name: 'open_media', arguments: JSON.stringify({ path: 'pixel.png' }) }
      : { name: 'handle_with_model', arguments: JSON.stringify({ modelId: step === 2 ? 'local:text' : 'local:vision' }) };
    return Response.json({
      id: `response-${step}`, object: 'chat.completion', created: 0, model: requests.at(-1)!.model,
      choices: [{ index: 0, finish_reason: step < 4 ? 'tool_calls' : 'stop', message: step < 4
        ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${step}`, type: 'function', function: call }] }
        : { role: 'assistant', content: 'done' },
      }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    });
  };
  const registry = ModelRegistry.load(root, 'local:vision');
  const model = await registry.getActive();
  const streams = new StreamRegistry([], root);
  t.after(() => streams.stop());
  const lookout = new Lookout(streams, new EventLog(root), registry, false, root);
  assert.deepEqual(await lookout.receive({
    id: 'media', at: new Date().toISOString(), lastFlickerMs: 1000,
    trigger: 'delta', modelId: model.id, model, deltas: [],
  }), { text: 'done', toolCallCount: 3 });
  assert.deepEqual(requests.map(request => request.model), ['vision', 'vision', 'text', 'vision']);
  const images = requests.map(request => request.messages.flatMap(message =>
    Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : []));
  assert.deepEqual(images.map(parts => parts.length), [0, 1, 0, 1]);
  assert.equal(images[3][0].image_url.url, `data:image/png;base64,${image}`);
});

test('image, audio, and video sounding deltas reach the provider and survive into the next turn', async t => {
  const root = mkdtempSync(join(tmpdir(), 'watch-sounding-media-'));
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.WATCH_CONTRACT_API_KEY;
  const requests: Array<{ messages: Array<Record<string, any>> }> = [];
  process.env.WATCH_CONTRACT_API_KEY = 'test-key';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.WATCH_CONTRACT_API_KEY;
    else process.env.WATCH_CONTRACT_API_KEY = previousKey;
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ models: {
    'novitaai:test': {
      provider: 'novitaai', model: 'test', baseURL: 'http://watch.test/v1', apiKeyEnv: 'WATCH_CONTRACT_API_KEY',
      capabilities: { tools: true, text: true, images: true, audio: true, video: true },
    },
  } }));
  globalThis.fetch = async (input, init) => {
    if (String(input) === 'https://models.dev/api.json') return Response.json({});
    assert.equal(String(input), 'http://watch.test/v1/chat/completions');
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({
      id: `response-${requests.length}`, object: 'chat.completion', created: 0, model: 'test',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'observed' } }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    });
  };
  const registry = ModelRegistry.load(root, 'novitaai:test');
  const model = await registry.getActive();
  const streams = new StreamRegistry([], root);
  t.after(() => streams.stop());
  const lookout = new Lookout(streams, new EventLog(root), registry, false, root);
  const sounding: Sounding = {
    id: 'media', at: new Date().toISOString(), lastFlickerMs: 1000,
    trigger: 'delta', modelId: model.id, model,
    deltas: ['image/jpeg', 'audio/wav', 'video/mp4'].map((mediaType, index) => ({
      stream: `media-${index}`, at: new Date().toISOString(), payload: { mediaType, dataBase64: 'YWJj' },
    })),
  };
  await lookout.receive(sounding);
  await lookout.receive({ ...sounding, id: 'next', trigger: 'heartbeat', deltas: [] });
  for (const request of requests) {
    const parts = request.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
    assert.ok(parts.some(part => part.type === 'image_url' && part.image_url.url === 'data:image/jpeg;base64,YWJj'));
    assert.ok(parts.some(part => part.type === 'input_audio' && part.input_audio.data === 'YWJj'));
    assert.ok(parts.some(part => part.type === 'video_url' && part.video_url.url === 'data:video/mp4;base64,YWJj'));
  }
  assert.equal(requests.length, 2);
});
