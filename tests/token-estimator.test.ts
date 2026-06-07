import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextTokenTracker, estimateModelValue } from '../src/token-estimator.js';
import type { ModelMessage } from 'ai';

test('estimates mp4 media by byte ratio instead of base64 text length', () => {
  const bytes = 250_000;
  const base64 = 'a'.repeat(Math.ceil(bytes / 0.75));
  const estimate = estimateModelValue({
    mediaType: 'video/mp4',
    dataBase64: base64,
    filename: 'desktop.mp4',
  });

  assert.ok(estimate.tokens > 3400);
  assert.ok(estimate.tokens < 3800);
  assert.equal(estimate.media[0]?.mediaType, 'video/mp4');
  assert.equal(estimate.media[0]?.ratio, 0.014);
});

test('provider input tokens replace prior message estimates as an anchor', () => {
  const tracker = new ContextTokenTracker();
  const messages: ModelMessage[] = [
    { role: 'user', content: 'x'.repeat(4000) },
  ];

  assert.ok(tracker.estimateMessages(messages).tokens >= 1000);
  tracker.recordProviderInput(123, messages);
  assert.equal(tracker.estimateMessages(messages).tokens, 123);

  messages.push({ role: 'assistant', content: 'y'.repeat(400) });
  const anchored = tracker.estimateMessages(messages).tokens;
  assert.ok(anchored > 123);
  assert.ok(anchored < 250);
});
