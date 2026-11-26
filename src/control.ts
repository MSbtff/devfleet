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
  | { cmd: 'restart'; names: string[]; build?: boolean }
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

/** Thrown when the socket directory or a socket in it could be controlled by another user. */
export class UnsafeControlDirError extends Error {
  override name = 'UnsafeControlDirError';
}

const isWindows = process.platform === 'win32';

/** The current user's ID. Only called off Windows, where `process.getuid` always exists. */
const currentUid = (): number => process.getuid?.() ?? -1;

/** Whether `dir` is a real directory owned by the current user that nobody else can write to. */
function isOwnPrivateDir(dir: string): boolean {
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  return Boolean(stat?.isDirectory() && stat.uid === currentUid() && (stat.mode & 0o022) === 0);
}

/**
 * Directory that holds the control sockets, private to the current user.
 * `$XDG_RUNTIME_DIR/devfleet` when that is set and belongs to this user, otherwise `<tmpdir>/devfleet-<uid>`.
 * Both stay short enough for the Unix socket path limit (about 104 bytes), which long project paths would not.
 */
export function controlDir(env: NodeJS.ProcessEnv = process.env): string {
  const runtime = env.XDG_RUNTIME_DIR;
  // A relative or foreign XDG_RUNTIME_DIR (left over after `su`, for example) is ignored, as the XDG spec asks.
  if (runtime && path.isAbsolute(runtime) && isOwnPrivateDir(runtime)) return path.join(runtime, 'devfleet');
  return path.join(os.tmpdir(), `devfleet-${currentUid()}`);
}

/** Socket path for a config file: a named pipe on Windows, a socket in {@link controlDir} elsewhere. */
export function controlPath(config: Pick<Config, 'root' | 'file'>): string {
  let target = path.resolve(config.file ?? config.root);
  try {
    target = fs.realpathSync(target); // the same project reached through a symlink gets the same socket
  } catch {
    /* not created yet */
  }
  const id = crypto.createHash('sha1').update(target).digest('hex').slice(0, 12);
  // Windows named pipes keep the default named-pipe ACL (full control for the creator, SYSTEM, and
  // administrators; read-only for everyone else). Node has no API to set a pipe's ACL, so they are left as they were.
  return isWindows ? `\\\\.\\pipe\\devfleet-${id}` : path.join(controlDir(), `${id}.sock`);
}

/**
 * Throws {@link UnsafeControlDirError} unless `dir` is a directory (not a symlink) owned by `uid`
 * with no permissions for group or others. Another user who could write there could plant a socket
 * that `devfleet restart` and `stop` would talk to.
 */
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

/** Creates the socket directory with mode 700 if it is missing, then checks it. */
export function ensureControlDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  checkControlDir(dir);
}

/**
 * Removes C0 control characters except tab, DEL, and C1 control characters, so text from the socket
 * cannot carry ANSI/OSC escape sequences (or bare ESC, CSI, BEL) to the terminal.
 */
export function stripControlChars(text: string): string {
  return text.replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g, '');
}

/** Service names a client may send. Letters and digits in any script plus a few separators, no spaces or controls. */
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

/** JSON reviver that strips control characters from every string value. */
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
  if (!isWindows) ensureControlDir(path.dirname(socketPath));
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
    // The directory is already private; this keeps the socket private even if it is moved or the directory loosened.
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

/**
 * Sends a request to the running `devfleet up`. Progress lines go to `onLog`.
 * Resolves with null when no `devfleet up` is running for this config.
 * Every string in the reply has control characters removed, so it is safe to print.
 * Rejects with {@link UnsafeControlDirError} when the socket directory is not private to this user.
 */
export function sendControl(
  socketPath: string,
  request: ControlRequest,
  onLog: (text: string) => void = () => {},
): Promise<ControlResult | null> {
  if (!isWindows) {
    const dir = path.dirname(socketPath);
    if (!fs.existsSync(dir)) return Promise.resolve(null); // nothing has ever listened here
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
        .on('error', () => {}) // reported through the socket's own error handler
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
