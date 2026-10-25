import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WatchRuntime } from '../src/runtime.js';
import { Scratchpad } from '../src/scratchpad.js';
import { StreamRegistry } from '../src/streams.js';
import { EventLog } from '../src/event-log.js';
import { createScratchpadTools } from '../src/tools/scratchpad.js';
import type { LookoutToolContext } from '../src/tools/context.js';
import type { ModelCapabilities, Sounding, WatchConfig, WatchEvent } from '../src/types.js';

const capabilities: ModelCapabilities = {
  tools: true, text: true, images: true, audio: true, video: true, pdf: true, source: 'test',
};

test('presence produces inference without a message, then consumes a waking inbox message', async t => {
  const root = mkdtempSync(join(tmpdir(), 'watch-presence-contract-'));
  const previousFetch = globalThis.fetch;
  const prompts: string[] = [];
  mkdirSync(join(root, 'memory'));
  const archivedFiles = ['lattice.jsonl', 'seed-crystals.jsonl', 'refinements.jsonl'];
  for (const file of archivedFiles) writeFileSync(join(root, 'memory', file), 'archived material must remain inert');
  const scratchpad = new Scratchpad(root);
  scratchpad.updateAgent('The workshop is in the north room.');
  writeFileSync(scratchpad.paths.userPath, 'User prefers a quiet workspace.');
  writeFileSync(join(root, 'config.json'), JSON.stringify({ instanceVersion: 2, models: {
    'local:test': {
      provider: 'openai-compatible', model: 'test', baseURL: 'http://watch.test/v1', capabilities,
    },
  } }));
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'http://watch.test/v1/models') return Response.json({ data: [{ id: 'test' }] });
    assert.equal(url, 'http://watch.test/v1/chat/completions');
    prompts.push(String(init?.body));
    return Response.json({
      id: `response-${prompts.length}`, object: 'chat.completion', created: 0, model: 'test',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'present' } }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    });
  };
  const config: WatchConfig = {
    instanceVersion: 2, cloneRoot: process.cwd(), instanceRoot: root,
    minCffMs: 0, maxCffMs: 250, modelTimeoutMs: 1000,
    defaultModel: 'local:test', availableModels: [],
    webApiStreams: [], sseStreams: [], cameraStreams: [],
    discord: { enabled: false }, moltbook: { enabled: false },
    scratchpad: {}, restAfterNoToolSoundings: 3,
    estimatedTokenWarningThreshold: 120000, noModel: false,
  };
  const runtime = new WatchRuntime(config);
  t.after(async () => {
    await runtime.stop('contract complete');
    globalThis.fetch = previousFetch;
    rmSync(root, { recursive: true, force: true });
  });
  const started: Sounding[] = [];
  runtime.subscribeEvents(event => {
    if (event.type === 'sounding_started') started.push(event.sounding);
  });
  const first = nextFinishedSounding(runtime);
  runtime.start();
  assert.equal((await first).text, 'present');
  assert.equal(started[0]?.trigger, 'heartbeat');
  assert.equal(started[0]?.deltas.some(delta => delta.stream === 'inbox'), false);
  assert.match(prompts[0]!, /workshop is in the north room/);
  assert.match(prompts[0]!, /quiet workspace/);
  const second = nextFinishedSounding(runtime);
  writeFileSync(scratchpad.paths.userPath, 'User prefers daylight in the workshop.');
  runtime.enqueueInboxMessage('a new observation', 'test');
  assert.equal((await second).text, 'present');
  assert.equal(started[1]?.trigger, 'delta');
  assert.ok(started[1]?.deltas.some(delta => delta.stream === 'inbox'));
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /a new observation/);
  assert.match(prompts[1]!, /daylight in the workshop/);
  for (const prompt of prompts) {
    assert.doesNotMatch(prompt, /archived material must remain inert/);
    const toolNames = JSON.parse(prompt).tools.map((tool: { function: { name: string } }) => tool.function.name);
    assert.ok(toolNames.includes('scratchpad_update_agent'));
    assert.ok(toolNames.every((name: string) => !/^(memory_|seed_crystal_|refinement_)/.test(name)));
  }
  for (const file of archivedFiles) {
    assert.equal(readFileSync(join(root, 'memory', file), 'utf8'), 'archived material must remain inert');
  }
  const status = await runtime.status();
  assert.equal(status.running, true);
  assert.equal((status.presence as { state: string }).state, 'ready');
});

test('finite text consumption progresses once per sounding and resumes from its saved cursor', async t => {
  const root = mkdtempSync(join(tmpdir(), 'watch-book-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const content = 'chapter-one|chapter-two|chapter-three';
  writeFileSync(join(root, 'book.txt'), content);
  let streams = new StreamRegistry([], root);
  const opened = await streams.openTextFileStream({ path: 'book.txt', charsPerSounding: 13 });
  const chunks = [String((opened.firstChunk as Record<string, unknown>).chunk)];
  for (let sounding = 0; sounding < 2; sounding++) {
    const deltas = await streams.popDeltas({ now: new Date(), capabilities });
    const book = deltas.find(delta => delta.stream === opened.stream);
    assert.ok(book);
    chunks.push(String(book.payload.chunk));
    const snapshot = streams.snapshot();
    streams.stop();
    streams = new StreamRegistry([], root, snapshot);
  }
  assert.equal(chunks.join(''), content);
  assert.equal(streams.listSubscriptions().includes(String(opened.stream)), false);
  const afterEnd = await streams.popDeltas({ now: new Date(), capabilities });
  assert.equal(afterEnd.some(delta => delta.stream === opened.stream), false);
  streams.stop();
});

test('scratchpad tools preserve orientation across reentry and leave user-owned notes intact', async t => {
  const root = mkdtempSync(join(tmpdir(), 'watch-scratchpad-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scratchpad = new Scratchpad(root, { agentMaxChars: 100 });
  const log = new EventLog(root);
  const tools = createScratchpadTools({ scratchpad, log } as LookoutToolContext);
  writeFileSync(scratchpad.paths.userPath, 'User prefers a quiet workspace.');
  const result = await tools.scratchpad_update_agent.execute!({ content: 'The workshop is in the north room.' }, { toolCallId: 'save', messages: [] });
  assert.equal(result.ok, true);
  const reentered = new Scratchpad(root, { agentMaxChars: 100 });
  assert.match(reentered.agentPrompt(), /workshop is in the north room/);
  assert.equal((reentered.read().user as Record<string, unknown>).content, 'User prefers a quiet workspace.');
  const rejected = await tools.scratchpad_update_agent.execute!({ content: 'x'.repeat(101) }, { toolCallId: 'rejected', messages: [] });
  assert.equal(rejected.ok, false);
  assert.match(reentered.agentPrompt(), /workshop is in the north room/);
  assert.equal((reentered.read().user as Record<string, unknown>).content, 'User prefers a quiet workspace.');
  assert.equal(log.tail().filter(event => event.type === 'scratchpad_updated').length, 1);
  assert.equal(existsSync(join(root, 'memory')), false);
});

function nextFinishedSounding(runtime: WatchRuntime): Promise<Extract<WatchEvent, { type: 'sounding_finished' }>> {
  return new Promise((resolve, reject) => {
    const unsubscribe = runtime.subscribeEvents(event => {
      if (event.type === 'sounding_finished') {
        clearTimeout(timeout);
        unsubscribe();
        resolve(event);
      } else if (event.type === 'sounding_failed') {
        clearTimeout(timeout);
        unsubscribe();
        reject(new Error(JSON.stringify(event.error)));
      }
    });
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('Expected a completed sounding'));
    }, 3000);
  });
}
