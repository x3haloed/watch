import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { createServer, Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { daemonLockPath, ensureWatchDir, socketPath } from './paths.js';
import type { ControlRequest, ControlResponse, WatchConfig } from './types.js';
import { WatchRuntime } from './runtime.js';
import { EventLog } from './event-log.js';

export async function runDaemon(config: WatchConfig): Promise<void> {
  const path = socketPath(config.repoRoot);
  const lock = acquireDaemonLock(config.repoRoot);
  process.once('exit', () => lock.release());
  let stopping = false;
  let rebooting = false;
  let server: ReturnType<typeof createServer> | undefined;
  const runtime = new WatchRuntime(config, () => {
    if (stopping || rebooting) {
      return;
    }
    rebooting = true;
    setTimeout(() => {
      void shutdown('reboot requested', true);
    }, 10);
  });

  async function shutdown(reason: string, restart = false): Promise<void> {
    if (stopping && !restart) {
      return;
    }
    stopping = true;
    await runtime.stop(reason);
    if (server) {
      await closeServer(server);
    }
    removeSocket(path);
    lock.release();
    if (restart) {
      spawnReplacementDaemon(config.repoRoot);
    }
    process.exit(0);
  }

  try {
    if (existsSync(path)) {
      unlinkSync(path);
    }

    const activeServer = createServer(socket => {
      handleSocket(socket, async request => {
        const response = await runtime.handle(request);
        if ((request.command === 'stop' || request.command === 'reboot') && !stopping && !rebooting) {
          stopping = true;
          setTimeout(() => {
            activeServer.close();
            if (existsSync(path)) {
              unlinkSync(path);
            }
          }, 10);
        }
        return response;
      });
    });
    server = activeServer;

    await new Promise<void>((resolve, reject) => {
      activeServer.once('error', reject);
      activeServer.listen(path, () => {
        activeServer.off('error', reject);
        resolve();
      });
    });

    runtime.start();

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (error) {
    removeSocket(path);
    lock.release();
    throw error;
  }
}

type DaemonLock = {
  release: () => void;
};

function acquireDaemonLock(repoRoot: string): DaemonLock {
  ensureWatchDir(repoRoot);
  const path = daemonLockPath(repoRoot);
  while (true) {
    try {
      mkdirSync(path, { recursive: false });
      writeFileSync(
        `${path}/owner.json`,
        JSON.stringify({ pid: process.pid, repoRoot, startedAt: new Date().toISOString() }, null, 2),
      );
      return {
        release: () => {
          try {
            rmSync(path, { recursive: true, force: true });
          } catch {
            // Best-effort cleanup; a stale lock is handled on next startup.
          }
        },
      };
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
      const owner = readLockOwner(path);
      if (owner.pid !== undefined && isProcessAlive(owner.pid)) {
        new EventLog(repoRoot).append({
          type: 'daemon_start_blocked',
          at: new Date().toISOString(),
          pid: owner.pid,
          lockPath: path,
          reason: `another daemon is already running for this repo root (pid ${owner.pid})`,
        });
        throw new Error(
          `Watch daemon already running for ${repoRoot} (pid ${owner.pid}). Stop it before starting another daemon in this directory.`,
        );
      }
      rmSync(path, { recursive: true, force: true });
    }
  }
}

function readLockOwner(path: string): { pid?: number } {
  try {
    const owner = JSON.parse(readFileSync(`${path}/owner.json`, 'utf8')) as { pid?: unknown };
    return typeof owner.pid === 'number' ? { pid: owner.pid } : {};
  } catch {
    return {};
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'EEXIST';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'EPERM';
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
