import { existsSync, unlinkSync } from 'node:fs';
import { createServer, Socket } from 'node:net';
import { socketPath } from './paths.js';
import type { ControlRequest, ControlResponse, WatchConfig } from './types.js';
import { WatchRuntime } from './runtime.js';

export async function runDaemon(config: WatchConfig): Promise<void> {
  const runtime = new WatchRuntime(config);
  const path = socketPath(config.repoRoot);
  let stopping = false;

  if (existsSync(path)) {
    unlinkSync(path);
  }

  const server = createServer(socket => {
    handleSocket(socket, async request => {
      const response = await runtime.handle(request);
      if (request.command === 'stop' && !stopping) {
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

  async function shutdown(reason: string): Promise<void> {
    await runtime.stop(reason);
    server.close();
    if (existsSync(path)) {
      unlinkSync(path);
    }
    process.exit(0);
  }
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
    if (request.command === 'stop') {
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
