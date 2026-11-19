import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import type { Config } from './types.ts';
import type { SummaryRow } from './runner.ts';

// A running `devfleet up` listens on a local socket so other terminals can query and control it.
// The protocol is newline-delimited JSON: one request line, then any number of `log` lines and one `result` line.

export type ControlRequest =
  | { cmd: 'status' }
  | { cmd: 'restart'; names: string[] }
  | { cmd: 'stop'; names: string[] }
  | { cmd: 'shutdown' };

export interface ControlResult {
  ok: boolean;
  error?: string;
  /** PID of the `devfleet up` process */
  pid?: number;
  rows?: SummaryRow[];
}

type Message = { type: 'log'; text: string } | ({ type: 'result' } & ControlResult);

export interface Reply {
  /** Sends a progress line to the client. */
  log(text: string): void;
  /** Sends the result and resolves once it has been flushed. */
  done(result: ControlResult): Promise<void>;
}

export type ControlHandler = (request: ControlRequest, reply: Reply) => void | Promise<void>;

export interface ControlServer {
  path: string;
  close(): Promise<void>;
}

/** Socket path for a config file. Kept in the temp folder so long project paths don't hit the Unix socket length limit. */
export function controlPath(config: Pick<Config, 'root' | 'file'>): string {
  let target = path.resolve(config.file ?? config.root);
  try {
    target = fs.realpathSync(target); // the same project reached through a symlink gets the same socket
  } catch {
    /* not created yet */
  }
  const id = crypto.createHash('sha1').update(target).digest('hex').slice(0, 12);
  return process.platform === 'win32' ? `\\\\.\\pipe\\devfleet-${id}` : path.join(os.tmpdir(), `devfleet-${id}.sock`);
}

function isRequest(value: unknown): value is ControlRequest {
  if (typeof value !== 'object' || value === null) return false;
  const { cmd, names } = value as { cmd?: unknown; names?: unknown };
  if (cmd === 'status' || cmd === 'shutdown') return true;
  return (cmd === 'restart' || cmd === 'stop') && Array.isArray(names) && names.every((n) => typeof n === 'string');
}

function listen(server: net.Server, socketPath: string): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve) => {
    const onError = (err: NodeJS.ErrnoException) => resolve(err);
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.off('error', onError);
      resolve(null);
    });
  });
}

/** Whether something is accepting connections on the socket. */
function isLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/**
 * Starts the control server. Returns null when another `devfleet up` for the same config already owns the socket.
 * A socket left behind by a process that was killed is removed and reused.
 */
export async function serveControl(socketPath: string, handler: ControlHandler): Promise<ControlServer | null> {
  const server = net.createServer((socket) => {
    socket.on('error', () => {
      /* the client went away; keep serving others */
    });
    const send = (message: Message) => {
      if (socket.writable) socket.write(`${JSON.stringify(message)}\n`);
    };
    let handled = false;
    const lines = readline.createInterface({ input: socket, crlfDelay: Infinity });
    lines.on('error', () => {}); // readline re-emits socket errors; the socket handler above covers them
    lines.on('line', (line) => {
      if (handled) return;
      handled = true;
      lines.close();
      let request: unknown;
      try {
        request = JSON.parse(line);
      } catch {
        request = null;
      }
      let finished = false;
      const reply: Reply = {
        log: (text) => send({ type: 'log', text }),
        done: (result) =>
          new Promise<void>((resolve) => {
            if (finished) return resolve();
            finished = true;
            send({ type: 'result', ...result });
            if (socket.writable) socket.end(resolve);
            else resolve();
          }),
      };
      if (!isRequest(request)) {
        void reply.done({ ok: false, error: 'invalid request' });
        return;
      }
      Promise.resolve(handler(request, reply)).catch((err: Error) => reply.done({ ok: false, error: err.message }));
    });
  });

  let err = await listen(server, socketPath);
  if (err?.code === 'EADDRINUSE' && process.platform !== 'win32') {
    if (await isLive(socketPath)) return null;
    fs.rmSync(socketPath, { force: true });
    err = await listen(server, socketPath);
  }
  if (err?.code === 'EADDRINUSE') return null;
  if (err) throw err;
  server.unref();

  const unlink = () => {
    if (process.platform !== 'win32') fs.rmSync(socketPath, { force: true });
  };
  process.once('exit', unlink);
  return {
    path: socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        process.off('exit', unlink);
        server.close(() => {
          unlink();
          resolve();
        });
      }),
  };
}

/**
 * Sends a request to the running `devfleet up`. Progress lines go to `onLog`.
 * Resolves with null when no `devfleet up` is running for this config.
 */
export function sendControl(
  socketPath: string,
  request: ControlRequest,
  onLog: (text: string) => void = () => {},
): Promise<ControlResult | null> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let connected = false;
    let result: ControlResult | null = null;
    socket.once('connect', () => {
      connected = true;
      socket.write(`${JSON.stringify(request)}\n`);
      readline
        .createInterface({ input: socket, crlfDelay: Infinity })
        .on('error', () => {}) // reported through the socket's own error handler
        .on('line', (line) => {
          let message: Message;
          try {
            message = JSON.parse(line) as Message;
          } catch {
            return;
          }
          if (message.type === 'log') onLog(message.text);
          else if (message.type === 'result') {
            const { type: _type, ...rest } = message;
            result = rest;
          }
        });
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (!connected) resolve(null); // no socket, or a stale one
      else if (!result) reject(new Error(`lost the connection to devfleet up: ${err.message}`));
    });
    socket.once('close', () => {
      if (!connected) return;
      if (result) resolve(result);
      else reject(new Error('devfleet up closed the connection without replying'));
    });
  });
}
