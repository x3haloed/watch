import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGameTools } from '../src/tools/game.js';
import type { LookoutToolContext } from '../src/tools/context.js';

test('game tools wait for authority and return camera as multimodal model output', async t => {
  let resolved = false;
  const png = Buffer.from('camera-png');
  const server = createServer((request, response) => {
    if (request.url === '/state') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(resolved ? {
        registered: true,
        accepting_actions: true,
        submitted_frame_id: 0,
        participant_id: 'aster',
        frame_id: 2,
        latest_result: { frame_id: 1, simulation_delta: 0.25 },
        personal_state: { position: [1, 0, 2], heading: 0 },
        roster: [{ participant_id: 'aster' }],
      } : {
        registered: true,
        accepting_actions: true,
        submitted_frame_id: 0,
        participant_id: 'aster',
        frame_id: 1,
        latest_result: {},
        personal_state: {},
        roster: [{ participant_id: 'aster' }],
      }));
      return;
    }
    if (request.url === '/action' && request.method === 'POST') {
      resolved = true;
      response.statusCode = 202;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === '/camera') {
      response.setHeader('content-type', 'image/png');
      response.end(png);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test address');

  const tools = createGameTools({
    game: { controlUrl: `http://127.0.0.1:${address.port}`, actionTimeoutMs: 2_000 },
  } as LookoutToolContext);
  const frameAction = tools.frame_action;
  assert.ok(frameAction && 'execute' in frameAction && frameAction.execute);
  const output = await frameAction.execute({ throttle: 0.5, steering: 0, brake: false });
  assert.equal((output as { camera?: string }).camera, png.toString('base64'));

  assert.ok('toModelOutput' in frameAction && frameAction.toModelOutput);
  const modelOutput = await frameAction.toModelOutput({
    toolCallId: 'tool-1',
    input: { throttle: 0.5, steering: 0, brake: false },
    output,
  });
  assert.equal(modelOutput.type, 'content');
  if (modelOutput.type !== 'content') return;
  assert.equal(modelOutput.value[0].type, 'text');
  assert.deepEqual(modelOutput.value[1], {
    type: 'media',
    data: png.toString('base64'),
    mediaType: 'image/png',
  });
});

test('game tools are absent when no game integration is configured', () => {
  assert.deepEqual(createGameTools({} as LookoutToolContext), {});
});
