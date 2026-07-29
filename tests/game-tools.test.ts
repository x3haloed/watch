import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGameTools } from '../src/tools/game.js';
import type { LookoutToolContext } from '../src/tools/context.js';

test('game tools wait for authority and return camera as multimodal model output', async t => {
  let resolvedFrame = 0;
  let lastActionKind = 'drive';
  const actionBodies: Array<Record<string, unknown>> = [];
  const cameraPaths: string[] = [];
  const webp = Buffer.from('camera-webp');
  const server = createServer((request, response) => {
    if (request.url === '/state') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        registered: true,
        accepting_actions: true,
        submitted_frame_id: 0,
        participant_id: 'aster',
        frame_id: resolvedFrame + 1,
        latest_result: resolvedFrame > 0
          ? { frame_id: resolvedFrame, simulation_delta: 0.25, action_kind: lastActionKind }
          : {},
        personal_state: resolvedFrame > 0 ? { position: [1, 0, 2], heading: 0 } : {},
        roster: [{ participant_id: 'aster' }],
      }));
      return;
    }
    if (request.url === '/action' && request.method === 'POST') {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        actionBodies.push(body);
        resolvedFrame = Number(body.frame_id);
        lastActionKind = String(body.kind);
        response.statusCode = 202;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    if (request.url === '/camera/contact-strip' || request.url === '/camera/inspection') {
      cameraPaths.push(request.url);
      response.setHeader('content-type', 'image/webp');
      response.end(webp);
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
  const output = await frameAction.execute({
    kind: 'hold',
    throttle: 0.5,
    steering: 0,
    brake: false,
    cameraTier: 'standard',
  });
  assert.equal((output as { camera?: string }).camera, webp.toString('base64'));
  assert.equal(cameraPaths[0], '/camera/contact-strip');
  assert.equal(actionBodies[0]?.kind, 'hold');

  assert.ok('toModelOutput' in frameAction && frameAction.toModelOutput);
  const modelOutput = await frameAction.toModelOutput({
    toolCallId: 'tool-1',
    input: {
      kind: 'hold',
      throttle: 0.5,
      steering: 0,
      brake: false,
      cameraTier: 'standard',
    },
    output,
  });
  assert.equal(modelOutput.type, 'content');
  if (modelOutput.type !== 'content') return;
  assert.equal(modelOutput.value[0].type, 'text');
  assert.deepEqual(modelOutput.value[1], {
    type: 'media',
    data: webp.toString('base64'),
    mediaType: 'image/webp',
  });
  assert.match(String((modelOutput.value[0] as { text?: string }).text), /"action_kind":"hold"/);

  const inspectionOutput = await frameAction.execute({
    kind: 'drive',
    throttle: 0,
    steering: 0,
    brake: true,
    cameraTier: 'inspection',
  });
  assert.equal((inspectionOutput as { camera?: string }).camera, webp.toString('base64'));
  assert.equal(cameraPaths[1], '/camera/inspection');
  assert.equal(actionBodies[1]?.kind, 'drive');
});

test('game tools are absent when no game integration is configured', () => {
  assert.deepEqual(createGameTools({} as LookoutToolContext), {});
});
