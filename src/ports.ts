import net from 'node:net';
import { execFile } from 'node:child_process';

export interface Listener {
  pid: number;
  command: string;
}

function tryConnect(port: number, host: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function isPortOpen(port: number, timeoutMs = 500): Promise<boolean> {
  if (await tryConnect(port, '127.0.0.1', timeoutMs)) return true;
  return tryConnect(port, '::1', timeoutMs);
}

export function findListeners(port: number): Promise<Listener[]> {
  if (process.platform === 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], (err, stdout) => {
      if (err && !stdout) return resolve([]);
      const result: Listener[] = [];
      let current: Listener | null = null;
      for (const line of stdout.split('\n')) {
        if (line.startsWith('p')) {
          current = { pid: Number(line.slice(1)), command: '' };
          result.push(current);
        } else if (line.startsWith('c') && current) {
          current.command = line.slice(1);
        }
      }
      resolve(result);
    });
  });
}

export function describeListeners(listeners: readonly Listener[]): string {
  return listeners.length ? listeners.map((l) => `PID ${l.pid} ${l.command}`.trim()).join(', ') : 'unknown process';
}
