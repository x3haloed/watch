import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyInferenceError, modelFailureTraceMessage } from '../src/lookout-helpers.js';
import type { Sounding } from '../src/types.js';

test('classifies ordinary provider 400s as non-retryable and extracts provider detail', () => {
  const error = Object.assign(new Error('Invalid JSON response'), {
    statusCode: 400,
    isRetryable: false,
    responseBody: JSON.stringify({
      error: {
        message: 'Provider returned error',
        code: 400,
      },
    }),
  });

  assert.deepEqual(classifyInferenceError(error), {
    kind: 'non_retryable_provider_error',
    retryable: false,
    statusCode: 400,
    providerErrorCode: 400,
    providerErrorMessage: 'Provider returned error',
  });
});

test('classifies rate limits and server errors as retryable provider errors', () => {
  assert.equal(classifyInferenceError(Object.assign(new Error('rate limited'), {
    statusCode: 429,
    isRetryable: true,
  })).kind, 'retryable_provider_error');

  assert.equal(classifyInferenceError(Object.assign(new Error('upstream unavailable'), {
    statusCode: 503,
    isRetryable: true,
  })).kind, 'retryable_provider_error');
});

test('model failure trace preserves completed-step context for the next turn', () => {
  const sounding: Sounding = {
    id: 'sounding-1',
    at: '2026-06-11T14:20:20.000Z',
    lastFlickerMs: 1000,
    trigger: 'delta',
    deltas: [],
    modelId: 'openrouter:openrouter/owl-alpha',
    model: {
      id: 'openrouter:openrouter/owl-alpha',
      provider: 'openrouter',
      model: 'openrouter/owl-alpha',
      capabilities: { tools: true, text: true },
    },
  };

  const message = modelFailureTraceMessage(sounding, 2, 1, {
    kind: 'non_retryable_provider_error',
    retryable: false,
    statusCode: 400,
    providerErrorMessage: 'Provider returned error',
  });

  assert.equal(message.role, 'user');
  assert.match(String(message.content), /Previous Sounding failed/);
  assert.match(String(message.content), /2 response message\(s\)/);
  assert.match(String(message.content), /retryable: false/);
  assert.match(String(message.content), /status_code: 400/);
});
