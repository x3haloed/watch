import { existsSync, unlinkSync } from 'node:fs';
import { createServer, Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { socketPath } from './paths.js';
import type { ControlRequest, ControlResponse, WatchConfig } from './types.js';
import { WatchRuntime } from './runtime.js';

export async function runDaemon(config: WatchConfig): Promise<void> {
  const path = socketPath(config.repoRoot);
  let stopping = false;
  let rebooting = false;
  const runtime = new WatchRuntime(config, () => {
    if (stopping || rebooting) {
      return;
    }
    rebooting = true;
    setTimeout(() => {
      void shutdown('reboot requested', true);
    }, 10);
  });

  if (existsSync(path)) {
    unlinkSync(path);
  }

  const server = createServer(socket => {
    handleSocket(socket, async request => {
      const response = await runtime.handle(request);
      if ((request.command === 'stop' || request.command === 'reboot') && !stopping && !rebooting) {
        stopping = true;
        setTimeout(() => {
          server.close();
          if (existsSync(path)) {
            unlinkSync(path);
          }
        }, 10);
      }
      return response;
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });

  runtime.start();

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  async function shutdown(reason: string, restart = false): Promise<void> {
    if (stopping && !restart) {
      return;
    }
    stopping = true;
    await runtime.stop(reason);
    await closeServer(server);
    removeSocket(path);
    if (restart) {
      spawnReplacementDaemon(config.repoRoot);
    }
    process.exit(0);
  }
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise(resolve => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function removeSocket(path: string): void {
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

function spawnReplacementDaemon(cwd: string): void {
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    cwd,
    env: process.env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function handleSocket(
  socket: Socket,
  handler: (request: ControlRequest) => Promise<ControlResponse>,
): void {
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      void respond(line, socket, handler);
      newline = buffer.indexOf('\n');
    }
  });
}

async function respond(
  line: string,
  socket: Socket,
  handler: (request: ControlRequest) => Promise<ControlResponse>,
): Promise<void> {
  try {
    const request = JSON.parse(line) as ControlRequest;
    const response = await handler(request);
    socket.write(`${JSON.stringify(response)}\n`);
    if (request.command === 'stop' || request.command === 'reboot') {
      socket.end();
    }
  } catch (error) {
    socket.write(
      `${JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  }
}
