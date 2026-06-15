import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateText, type ModelMessage } from 'ai';
import { ModelRegistry } from '../src/model-registry.js';
import { messagesForModel, requiredApiKeyEnv } from '../src/lookout-helpers.js';
import type { ResolvedModel } from '../src/types.js';

test('infers NovitaAI models from provider-prefixed ids', async () => {
  const root = mkdtempSync(join(tmpdir(), 'watch-model-registry-'));
  const previousFetch = globalThis.fetch;
  const fetchedUrls: string[] = [];

  globalThis.fetch = async input => {
    const url = String(input);
    fetchedUrls.push(url);
    if (url === 'https://models.dev/api.json') {
      return Response.json({
        'novita-ai': {
          models: {
            'moonshotai/kimi-k2-instruct': {
              tool_call: true,
              structured_output: true,
              modalities: { input: ['text'], output: ['text'] },
              limit: { context: 131072, output: 8192 },
            },
          },
        },
      });
    }
    if (url === 'https://api.novita.ai/openai/models') {
      return Response.json({ data: [{ id: 'moonshotai/kimi-k2-instruct' }] });
    }
    return new Response(null, { status: 404 });
  };

  try {
    const registry = ModelRegistry.load(root, 'novitaai:moonshotai/kimi-k2-instruct');
    const model = await registry.getActive();

    assert.equal(model.provider, 'novitaai');
    assert.equal(model.model, 'moonshotai/kimi-k2-instruct');
    assert.equal(model.baseURL, 'https://api.novita.ai/openai');
    assert.equal(model.apiKeyEnv, 'NOVITA_API_KEY');
    assert.equal(model.capabilities.tools, true);
    assert.equal(model.capabilities.source, 'models.dev');
    assert.equal(requiredApiKeyEnv(model), 'NOVITA_API_KEY');
    assert.deepEqual(await registry.checkAvailable(model), { ok: true });
    assert.deepEqual(fetchedUrls, ['https://models.dev/api.json', 'https://api.novita.ai/openai/models']);
  } finally {
    globalThis.fetch = previousFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test('accepts NovitaAI alias prefixes', () => {
  const root = mkdtempSync(join(tmpdir(), 'watch-model-registry-'));

  try {
    const registry = ModelRegistry.load(root, 'novita:deepseek/deepseek-v3-0324', ['novita-ai:qwen/qwen3-coder']);

    assert.equal(registry.activeId, 'novita:deepseek/deepseek-v3-0324');
    assert.deepEqual(registry.listModelIds(), [
      'local:auto',
      'novita-ai:qwen/qwen3-coder',
      'novita:deepseek/deepseek-v3-0324',
      'ollama:auto',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('NovitaAI request transform emits documented video and audio content parts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'watch-model-registry-'));
  const registry = ModelRegistry.load(root, 'novitaai:moonshotai/kimi-k2-instruct');
  const previousFetch = globalThis.fetch;
  const previousApiKey = process.env.NOVITA_API_KEY;
  const requests: Array<{ url: string; body: unknown }> = [];
  const model: ResolvedModel = {
    id: 'novitaai:moonshotai/kimi-k2-instruct',
    provider: 'novitaai',
    model: 'moonshotai/kimi-k2-instruct',
    baseURL: 'https://api.novita.ai/openai',
    apiKeyEnv: 'NOVITA_API_KEY',
    capabilities: {
      tools: true,
      text: true,
      images: true,
      audio: true,
      video: true,
      pdf: false,
      source: 'test',
    },
  };

  process.env.NOVITA_API_KEY = 'test-key';
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Response.json({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 0,
      model: model.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  };

  try {
    await generateText({
      model: registry.createLanguageModel(model),
      messages: messagesForModel(model, [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'inspect' },
            { type: 'image', image: 'image123', mediaType: 'image/jpeg' },
            { type: 'file', data: 'video123', mediaType: 'video/mp4' },
            { type: 'file', data: 'audio123', mediaType: 'audio/mpeg3' },
          ],
        } as ModelMessage,
      ]),
    });

    assert.equal(requests[0]?.url, 'https://api.novita.ai/openai/chat/completions');
    assert.deepEqual((requests[0]?.body as { messages: Array<{ content: unknown[] }> }).messages[0]?.content, [
      { type: 'text', text: 'inspect' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,image123' } },
      { type: 'video_url', video_url: { url: 'data:video/mp4;base64,video123' } },
      { type: 'input_audio', input_audio: { data: 'audio123', format: 'mp3' } },
    ]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) {
      delete process.env.NOVITA_API_KEY;
    } else {
      process.env.NOVITA_API_KEY = previousApiKey;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
