import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { createServer, Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { daemonLockPath, ensureInstanceDir, socketPath, stateDir } from './paths.js';
import type { ControlRequest, ControlResponse, WatchConfig, SseStreamConfig } from './types.js';
import { WatchRuntime } from './runtime.js';
import { EventLog } from './event-log.js';
import { startCompanionHost, type CompanionHost } from './companion-host.js';
import { redactDiagnosticText } from './daemon-lifecycle.js';

export async function runDaemon(config: WatchConfig): Promise<void> {
  const fatalLog = new EventLog(config.instanceRoot);
  const observeFatalError = (error: Error) => {
    try {
      fatalLog.append({
        type: 'daemon_fatal_error',
        at: new Date().toISOString(),
        pid: process.pid,
        error: redactDiagnosticText(error.stack ?? error.message),
      });
    } catch {
      // Observation must never change the process's fatal-error behavior.
    }
  };
  process.on('uncaughtExceptionMonitor', observeFatalError);
  const path = socketPath(config.instanceRoot);
  const lock = acquireDaemonLock(config.instanceRoot);
  process.once('exit', () => lock.release());
  let stopping = false;
  let rebooting = false;
  let server: ReturnType<typeof createServer> | undefined;
  let companionHost: CompanionHost | undefined;
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
    if (companionHost) {
      await companionHost.close();
    }
    removeSocket(path);
    lock.release();
    process.off('uncaughtExceptionMonitor', observeFatalError);
    let exitCode = 0;
    if (restart) {
      const plan = daemonRestartPlan(process.env);
      if (plan.spawnReplacement) {
        spawnReplacementDaemon(config.cloneRoot);
      }
      exitCode = plan.exitCode;
    }
    process.exit(exitCode);
  }

  try {
    if (existsSync(path)) {
      unlinkSync(path);
    }

    const activeServer = createServer(socket => {
      handleSocket(socket, async request => {
        const response = await runtime.handle(request);
        if ((request.command === 'stop' || request.command === 'reboot') && !stopping && !rebooting) {
          setTimeout(() => {
            void shutdown(request.command === 'reboot' ? 'reboot requested' : 'control request', request.command === 'reboot');
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

    companionHost = await startCompanionHost(runtime);
    runtime.start();

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (error) {
    await companionHost?.close();
    removeSocket(path);
    lock.release();
    process.off('uncaughtExceptionMonitor', observeFatalError);
    throw error;
  }
}

export function daemonRestartPlan(env: NodeJS.ProcessEnv): { spawnReplacement: boolean; exitCode: number } {
  if (env.INVOCATION_ID?.trim()) {
    // systemd owns the cgroup. A non-zero exit delegates the restart to
    // Restart=on-failure without turning an intentional stop into a restart.
    return { spawnReplacement: false, exitCode: 75 };
  }
  return { spawnReplacement: true, exitCode: 0 };
}

type DaemonLock = {
  release: () => void;
};

function acquireDaemonLock(instanceRoot: string): DaemonLock {
  ensureInstanceDir(instanceRoot);
  mkdirSync(stateDir(instanceRoot), { recursive: true });
  const path = daemonLockPath(instanceRoot);
  while (true) {
    try {
      mkdirSync(path, { recursive: false });
      writeFileSync(
        `${path}/owner.json`,
        JSON.stringify({ pid: process.pid, instanceRoot, startedAt: new Date().toISOString() }, null, 2),
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
        new EventLog(instanceRoot).append({
          type: 'daemon_start_blocked',
          at: new Date().toISOString(),
          pid: owner.pid,
          lockPath: path,
          reason: `another daemon is already running for this repo root (pid ${owner.pid})`,
        });
        throw new Error(
          `Watch daemon already running for ${instanceRoot} (pid ${owner.pid}). Stop it before starting another daemon in this directory.`,
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
