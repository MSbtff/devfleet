import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import type { Config } from './types.ts';
import type { SummaryRow } from './runner.ts';

export type ControlRequest =
  | { cmd: 'status' }
  | { cmd: 'restart'; names: string[]; build?: boolean }
  | { cmd: 'stop'; names: string[] }
  | { cmd: 'shutdown' };

export interface ControlResult {
  ok: boolean;
  error?: string;
  pid?: number;
  rows?: SummaryRow[];
}

type Message = { type: 'log'; text: string } | ({ type: 'result' } & ControlResult);

export interface Reply {
  log(text: string): void;
  done(result: ControlResult): Promise<void>;
}

export type ControlHandler = (request: ControlRequest, reply: Reply) => void | Promise<void>;

export interface ControlServer {
  path: string;
  close(): Promise<void>;
}

export class UnsafeControlDirError extends Error {
  override name = 'UnsafeControlDirError';
}

const isWindows = process.platform === 'win32';

const currentUid = (): number => process.getuid?.() ?? -1;

function isOwnPrivateDir(dir: string): boolean {
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  return Boolean(stat?.isDirectory() && stat.uid === currentUid() && (stat.mode & 0o022) === 0);
}

export function controlDir(env: NodeJS.ProcessEnv = process.env): string {
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime && path.isAbsolute(runtime) && isOwnPrivateDir(runtime)) return path.join(runtime, 'devfleet');
  return path.join(os.tmpdir(), `devfleet-${currentUid()}`);
}

export function controlPath(config: Pick<Config, 'root' | 'file'>): string {
  let target = path.resolve(config.file ?? config.root);
  try {
    target = fs.realpathSync(target);
  } catch {
  }
  const id = crypto.createHash('sha1').update(target).digest('hex').slice(0, 12);
  return isWindows ? `\\\\.\\pipe\\devfleet-${id}` : path.join(controlDir(), `${id}.sock`);
}

export function checkControlDir(dir: string, uid: number = currentUid()): void {
  const stat = fs.lstatSync(dir);
  const refuse = (why: string) =>
    new UnsafeControlDirError(
      `Refusing to use ${dir} for the devfleet control socket: ${why}. ` +
        'Remove it (devfleet recreates it) or point XDG_RUNTIME_DIR at a private directory.',
    );
  if (stat.isSymbolicLink()) throw refuse('it is a symlink');
  if (!stat.isDirectory()) throw refuse('it is not a directory');
  if (stat.uid !== uid) throw refuse(`it is owned by uid ${stat.uid}, not ${uid}`);
  if (stat.mode & 0o077) throw refuse(`its mode is ${(stat.mode & 0o777).toString(8)}, expected 700`);
}

export function ensureControlDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  checkControlDir(dir);
}

export function stripControlChars(text: string): string {
  return text.replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g, '');
}

const SERVICE_NAME = /^[\p{L}\p{M}\p{N}._:@\/+-]{1,128}$/u;
const MAX_NAMES = 256;

function isRequest(value: unknown): value is ControlRequest {
  if (typeof value !== 'object' || value === null) return false;
  const { cmd, names, build } = value as { cmd?: unknown; names?: unknown; build?: unknown };
  if (cmd === 'status' || cmd === 'shutdown') return true;
  if (build !== undefined && (cmd !== 'restart' || typeof build !== 'boolean')) return false;
  return (
    (cmd === 'restart' || cmd === 'stop') &&
    Array.isArray(names) &&
    names.length <= MAX_NAMES &&
    names.every((n) => typeof n === 'string' && SERVICE_NAME.test(n))
  );
}

const sanitize = (_key: string, value: unknown): unknown =>
  typeof value === 'string' ? stripControlChars(value) : value;

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

export async function serveControl(socketPath: string, handler: ControlHandler): Promise<ControlServer | null> {
  if (!isWindows) ensureControlDir(path.dirname(socketPath));
  const server = net.createServer((socket) => {
    socket.on('error', () => {
    });
    const send = (message: Message) => {
      if (socket.writable) socket.write(`${JSON.stringify(message)}\n`);
    };
    let handled = false;
    const lines = readline.createInterface({ input: socket, crlfDelay: Infinity });
    lines.on('error', () => {});
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
  if (err?.code === 'EADDRINUSE' && !isWindows) {
    if (await isLive(socketPath)) return null;
    const stale = fs.lstatSync(socketPath, { throwIfNoEntry: false });
    if (stale && stale.uid !== currentUid()) {
      throw new UnsafeControlDirError(`Refusing to remove ${socketPath}: it is owned by uid ${stale.uid}, not ${currentUid()}.`);
    }
    fs.rmSync(socketPath, { force: true });
    err = await listen(server, socketPath);
  }
  if (err?.code === 'EADDRINUSE') return null;
  if (err) throw err;
  if (!isWindows) {
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch (chmodErr) {
      server.close();
      throw chmodErr;
    }
  }
  server.unref();

  const unlink = () => {
    if (!isWindows) fs.rmSync(socketPath, { force: true });
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

export function sendControl(
  socketPath: string,
  request: ControlRequest,
  onLog: (text: string) => void = () => {},
): Promise<ControlResult | null> {
  if (!isWindows) {
    const dir = path.dirname(socketPath);
    if (!fs.existsSync(dir)) return Promise.resolve(null);
    try {
      checkControlDir(dir);
    } catch (err) {
      return Promise.reject(err);
    }
  }
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let connected = false;
    let result: ControlResult | null = null;
    socket.once('connect', () => {
      connected = true;
      socket.write(`${JSON.stringify(request)}\n`);
      readline
        .createInterface({ input: socket, crlfDelay: Infinity })
        .on('error', () => {})
        .on('line', (line) => {
          let message: Message;
          try {
            message = JSON.parse(line, sanitize) as Message;
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
      if (!connected) resolve(null);
      else if (!result) reject(new Error(`lost the connection to devfleet up: ${err.message}`));
    });
    socket.once('close', () => {
      if (!connected) return;
      if (result) resolve(result);
      else reject(new Error('devfleet up closed the connection without replying'));
    });
  });
}
