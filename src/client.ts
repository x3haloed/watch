import { createConnection } from 'node:net';
import { socketPath } from './paths.js';
import type { ControlRequest, ControlResponse } from './types.js';

export async function sendControl(cloneRoot: string, request: ControlRequest): Promise<ControlResponse> {
  const path = socketPath(cloneRoot);

  return await new Promise<ControlResponse>((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = '';

    socket.once('error', reject);
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) {
        return;
      }
      socket.end();
      const line = buffer.slice(0, newline);
      resolve(JSON.parse(line) as ControlResponse);
    });

    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
  });
}
