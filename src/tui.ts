import blessed from 'blessed';
import { existsSync, readFileSync } from 'node:fs';
import { eventLogPath } from './paths.js';
import { sendControl } from './client.js';
import type { ControlResponse } from './types.js';

type EventRecord = Record<string, any>;

export async function runOperatorConsole(repoRoot: string): Promise<void> {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'watch',
    fullUnicode: true,
  });

  const status = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 1,
    style: { fg: 'white', bg: 'blue' },
  });

  const messages = blessed.log({
    label: ' Messages ',
    top: 1,
    left: 0,
    width: '58%',
    height: '100%-4',
    border: 'line',
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: ' ', style: { bg: 'blue' } },
  });

  const mirror = blessed.box({
    label: ' Mirror ',
    top: 1,
    left: '58%',
    width: '42%',
    height: '55%-1',
    border: 'line',
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: ' ', style: { bg: 'blue' } },
  });

  const tools = blessed.log({
    label: ' Tool Trace ',
    top: '55%',
    left: '58%',
    width: '42%',
    height: '45%-3',
    border: 'line',
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: ' ', style: { bg: 'blue' } },
  });

  const composer = blessed.textbox({
    bottom: 0,
    left: 0,
    width: '100%',
    height: 3,
    border: 'line',
    label: ' Compose ',
    inputOnFocus: true,
    keys: true,
    mouse: true,
  });

  screen.append(status);
  screen.append(messages);
  screen.append(mirror);
  screen.append(tools);
  screen.append(composer);

  screen.key(['C-c', 'q'], () => process.exit(0));
  screen.key(['tab'], () => composer.focus());
  process.once('SIGINT', () => process.exit(0));

  composer.on('submit', value => {
    const text = String(value ?? '').trim();
    composer.clearValue();
    composer.focus();
    screen.render();
    void handleComposer(repoRoot, text, messages);
  });

  composer.focus();

  let lastRender = '';
  const render = async () => {
    const events = currentDaemonEvents(readEvents(repoRoot)).slice(-300);
    const daemon = await statusText(repoRoot);
    const nextRender = JSON.stringify({ daemon, tail: events.slice(-80) });
    if (nextRender === lastRender) return;
    lastRender = nextRender;

    status.setContent(` watch ${daemon}  Enter=send  /status /sound /stop /quit  q=quit  Tab=compose `);
    messages.setContent(renderMessages(events));
    mirror.setContent(renderMirror(events));
    tools.setContent(renderToolTrace(events));
    messages.setScrollPerc(100);
    tools.setScrollPerc(100);
    screen.render();
  };

  const interval = setInterval(() => void render(), 500);
  await render();

  await new Promise<void>(resolve => {
    screen.on('destroy', resolve);
  });
  clearInterval(interval);
}

async function handleComposer(repoRoot: string, text: string, messages: blessed.Widgets.Log): Promise<void> {
  if (!text) return;
  try {
    if (['/q', '/quit', '/exit'].includes(text)) process.exit(0);
    if (text === '/status') {
      const response = await sendControl(repoRoot, { command: 'status' });
      messages.log(`status ${shortJson(response.data ?? response.error)}`);
      return;
    }
    if (text === '/sound') {
      await sendControl(repoRoot, { command: 'sound' });
      messages.log('control manual Sounding requested');
      return;
    }
    if (text === '/stop') {
      await sendControl(repoRoot, { command: 'stop' });
      messages.log('control daemon stopped');
      return;
    }
    await sendControl(repoRoot, { command: 'send', message: text, source: 'cli' });
  } catch (error) {
    messages.log(`error ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function statusText(repoRoot: string): Promise<string> {
  try {
    const response = (await sendControl(repoRoot, { command: 'status' })) as ControlResponse;
    if (!response.ok) return `disconnected ${response.error ?? ''}`;
    const data = response.data as any;
    return [
      'connected',
      `model=${data.modelId ?? '-'}`,
      data.soundingActive ? 'running' : 'idle',
      data.soundQueued ? 'queued' : '',
      `cff=${data.minCffMs ?? '?'}-${data.maxCffMs ?? '?'}ms`,
    ]
      .filter(Boolean)
      .join(' ');
  } catch {
    return 'waiting for daemon';
  }
}

function renderMessages(events: EventRecord[]): string {
  const rows: string[] = [];
  for (const event of events) {
    if (event.type === 'stream_delta' && event.delta?.stream === 'inbox') {
      for (const entry of event.delta.payload?.entries ?? []) {
        rows.push(`${time(event.at)} ${entry.medium ?? 'inbox'} #${entry.id}: ${entry.subject}`);
      }
    }
    if (event.type === 'cli_message') {
      const reply = event.replyToId ? ` -> #${event.replyToId}` : '';
      rows.push(`${time(event.at)} agent${reply}: ${event.message}`);
    }
    if (event.type === 'sounding_finished' && event.text) {
      rows.push(`${time(event.at)} private: ${shortText(event.text, 500)}`);
    }
  }
  return rows.slice(-80).join('\n') || '(no messages yet)';
}

function renderMirror(events: EventRecord[]): string {
  const latestSounding = [...events].reverse().find(event => event.type === 'sounding_started')?.sounding;
  const latestFinished = [...events].reverse().find(event => event.type === 'sounding_finished');
  const latestFailure = [...events].reverse().find(event => event.type === 'sounding_failed');
  const active = inferActive(events);

  if (!latestSounding) return '(no Sounding yet)';

  const deltas = (latestSounding.deltas ?? [])
    .slice(-8)
    .map((delta: any) => `  ${delta.stream} ${formatDeltaPayload(delta.payload)}`)
    .join('\n');

  return [
    `Current Sounding`,
    `id: ${latestSounding.id}`,
    `at: ${latestSounding.at}`,
    `trigger: ${latestSounding.trigger}`,
    `model: ${latestSounding.modelId}`,
    `status: ${active}`,
    '',
    `Deltas`,
    deltas || '  (none)',
    '',
    `Last Output`,
    latestFinished ? shortText(latestFinished.text, 500) : '(none)',
    latestFailure ? `\nLast failure: ${latestFailure.error?.name ?? 'Error'}: ${latestFailure.error?.message ?? ''}` : '',
  ].join('\n');
}

function renderToolTrace(events: EventRecord[]): string {
  const rows = extractToolRows(events).slice(-80);
  return rows.join('\n') || '(no tool calls yet)';
}

function readEvents(repoRoot: string): EventRecord[] {
  const path = eventLogPath(repoRoot);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line) as EventRecord;
      } catch {
        return { type: 'parse_error', line };
      }
    });
}

function currentDaemonEvents(events: EventRecord[]): EventRecord[] {
  const lastStart = events.map(event => event.type).lastIndexOf('daemon_started');
  return lastStart === -1 ? events : events.slice(lastStart);
}

function inferActive(events: EventRecord[]): string {
  const latest = [...events]
    .reverse()
    .find(event =>
      ['sounding_started', 'sounding_finished', 'sounding_failed', 'model_step_finished', 'model_unavailable', 'model_aborted'].includes(
        event.type,
      ),
    );
  if (!latest) return 'idle';
  if (latest.type === 'sounding_started' || latest.type === 'model_step_finished') {
    return `running ${latest.soundingId ?? latest.sounding?.id}`;
  }
  if (latest.type === 'model_unavailable') return `unavailable ${latest.modelId}`;
  if (latest.type === 'model_aborted') return `aborted ${latest.soundingId}`;
  return `idle after ${latest.soundingId}`;
}

function extractToolRows(events: EventRecord[]): string[] {
  const rows: string[] = [];
  for (const event of events) {
    if (event.type === 'terminal_started') {
      rows.push(`${time(event.at)} ${event.soundingId} $ ${event.command} (${event.sessionId.slice(0, 8)})`);
    }
    if (event.type === 'terminal_output_delta') {
      rows.push(`${time(event.at)} ${event.sessionId.slice(0, 8)} ${event.stream}> ${shortText(event.text, 500)}`);
    }
    if (event.type === 'terminal_finished') {
      rows.push(
        `${time(event.at)} ${event.sessionId.slice(0, 8)} exit=${event.exitCode} ${event.durationMs}ms ${shortText(event.output, 500)}`,
      );
    }
    if (event.type === 'terminal_input') {
      rows.push(`${time(event.at)} ${event.sessionId.slice(0, 8)} stdin ${shortText(event.text, 160)}`);
    }
    if (event.type === 'terminal_killed') {
      rows.push(`${time(event.at)} ${event.sessionId.slice(0, 8)} killed`);
    }
    if (event.type !== 'model_step_finished') continue;
    const content = Array.isArray(event.step?.content) ? event.step.content : [];
    for (const part of content) {
      if (part?.type === 'tool-call') {
        rows.push(`${time(event.at)} ${event.soundingId} -> ${part.toolName} ${shortJson(part.input ?? part.args ?? part, 500)}`);
      }
      if (part?.type === 'tool-result') {
        rows.push(`${time(event.at)} ${event.soundingId} <- ${part.toolName} ${shortJson(part.output ?? part.result ?? part, 500)}`);
      }
    }
  }
  return rows;
}

function formatDeltaPayload(payload: any): string {
  if (Array.isArray(payload?.entries)) {
    return shortText(
      payload.entries
        .map((entry: any) => `#${entry.id} ${entry.medium ?? 'message'}: ${entry.subject} (${entry.hint})`)
        .join(' | '),
      300,
    );
  }
  return shortJson(payload, 220);
}

function time(value: unknown): string {
  return String(value ?? '').slice(11, 19);
}

function shortText(value: unknown, limit = 180): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function shortJson(value: unknown, limit = 180): string {
  return shortText(JSON.stringify(value), limit);
}
