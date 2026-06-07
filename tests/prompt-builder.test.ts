import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelMessage } from 'ai';
import { SoundingPromptBuilder } from '../src/sounding-prompt.js';
import type { ModelRegistry } from '../src/model-registry.js';
import type { SkillLibrary } from '../src/skills.js';
import type { ResolvedModel, Sounding } from '../src/types.js';

const model: ResolvedModel = {
  id: 'test:model',
  provider: 'openai-compatible',
  model: 'test-model',
  capabilities: {
    tools: true,
    text: true,
    images: true,
    audio: false,
    video: false,
    pdf: false,
    contextTokens: 100,
    outputTokens: 10,
    source: 'test',
  },
};

const sounding: Sounding = {
  id: 'sounding-1',
  at: '2026-06-07T00:00:00.000Z',
  lastFlickerMs: 1000,
  trigger: 'delta',
  modelId: model.id,
  model,
  deltas: [
    {
      stream: 'inbox',
      at: '2026-06-07T00:00:00.000Z',
      payload: { count: 1, entries: [{ id: 1, medium: 'cli', preview: 'hello' }] },
    },
  ],
};

test('formats a basic Sounding prompt with model and stream context', () => {
  const builder = promptBuilder([]);
  const result = builder.formatSounding({ sounding, model });

  assert.match(result.text, /sounding_id: sounding-1/);
  assert.match(result.text, /active_model: test:model/);
  assert.match(result.text, /subscriptions:\n- inbox/);
  assert.match(result.text, /inbox:/);
});

test('includes reroute and rest-model notices deterministically', () => {
  const builder = promptBuilder([]);
  const result = builder.formatSounding({
    sounding,
    model,
    reroute: { fromModelId: 'small', toModelId: 'large', params: { modelId: 'large' } },
    restModelNotice: { fromModelId: 'large', toModelId: 'small', noToolSoundings: 3 },
  });

  assert.match(result.text, /\[model_reroute\]/);
  assert.match(result.text, /from_model: small/);
  assert.match(result.text, /\[model_restored\]/);
  assert.match(result.text, /after 3 consecutive Soundings/);
});

test('emits context pressure once a threshold is crossed', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'x'.repeat(320) },
  ];
  const builder = promptBuilder(messages);
  const result = builder.formatSounding({ sounding, model });

  assert.match(result.text, /\[context_pressure\]/);
  assert.match(result.text, /threshold_crossed:/);
});

test('attaches supported image media from Sounding deltas', () => {
  const builder = promptBuilder([]);
  const mediaSounding: Sounding = {
    ...sounding,
    deltas: [
      {
        stream: 'camera:motion',
        at: sounding.at,
        payload: { dataBase64: 'abc123', mediaType: 'image/jpeg', sequence: 1 },
      },
    ],
  };
  const result = builder.formatSounding({ sounding: mediaSounding, model });

  assert.deepEqual(result.mediaParts, [{ type: 'image', image: 'abc123', mediaType: 'image/jpeg' }]);
  assert.doesNotMatch(result.text, /abc123/);
});

function promptBuilder(messages: ModelMessage[]): SoundingPromptBuilder {
  const models = {
    listModelIds: () => [model.id],
    resolveAll: async () => [model],
  } as unknown as ModelRegistry;
  const skills = {
    summaries: async () => [],
  } as unknown as SkillLibrary;
  return new SoundingPromptBuilder({
    cwd: '/tmp/watch-test',
    contextPrompt: Promise.resolve('[context]\n[/context]'),
    models,
    skills,
    listSubscriptions: () => ['inbox'],
    messages,
    restingModelId: model.id,
    restAfterNoToolSoundings: 3,
    estimatedTokenWarningThreshold: 1000,
  });
}
