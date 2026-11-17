import net from 'node:net';
import { execFile } from 'node:child_process';

function tryConnect(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const finish = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** 로컬에서 해당 포트로 접속되는지 확인한다 (IPv4, IPv6 모두). */
export async function isPortOpen(port, timeoutMs = 500) {
  if (await tryConnect(port, '127.0.0.1', timeoutMs)) return true;
  return tryConnect(port, '::1', timeoutMs);
}

/** 포트를 LISTEN 중인 프로세스 목록. lsof가 없으면 빈 배열. */
export function findListeners(port) {
  if (process.platform === 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], (err, stdout) => {
      if (err && !stdout) return resolve([]);
      const result = [];
      let current = null;
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

export function describeListeners(listeners) {
  return listeners.length ? listeners.map((l) => `PID ${l.pid} ${l.command}`.trim()).join(', ') : '알 수 없는 프로세스';
}
