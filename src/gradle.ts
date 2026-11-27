import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const REGISTRY_PROPERTY = 'org.gradle.daemon.registry.base';
const LOG_FILE = /^daemon-(\d+)\.out\.log$/;
const IS_WIN = process.platform === 'win32';

export function withDaemonRegistry(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const option = IS_WIN
    ? /\s/.test(dir)
      ? `"-D${REGISTRY_PROPERTY}=${dir}"`
      : `-D${REGISTRY_PROPERTY}=${dir}`
    : `-D${REGISTRY_PROPERTY}=${dir.replace(/[^-\w+,./:=@]/g, '\\$&')}`;
  return { ...env, GRADLE_OPTS: env.GRADLE_OPTS ? `${env.GRADLE_OPTS} ${option}` : option };
}

interface DaemonLog {
  pid: number;
  files: string[];
  mtimeMs: number;
}

function daemonLogs(dir: string): DaemonLog[] {
  const logs = new Map<number, DaemonLog>();
  let versions: string[];
  try {
    versions = fs.readdirSync(dir);
  } catch {
    return [];
  }
  for (const version of versions) {
    let files: string[];
    try {
      files = fs.readdirSync(path.join(dir, version));
    } catch {
      continue;
    }
    for (const file of files) {
      const pid = Number(LOG_FILE.exec(file)?.[1]);
      if (!(pid > 0)) continue;
      const full = path.join(dir, version, file);
      const mtimeMs = fs.statSync(full, { throwIfNoEntry: false })?.mtimeMs ?? 0;
      const log = logs.get(pid) ?? { pid, files: [], mtimeMs: 0 };
      log.files.push(full);
      log.mtimeMs = Math.max(log.mtimeMs, mtimeMs);
      logs.set(pid, log);
    }
  }
  return [...logs.values()];
}

export function parseElapsed(text: string): number | null {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!match) return null;
  const [, days = '0', hours = '0', minutes, seconds] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

function processInfo(pid: number): Promise<{ command: string; startedAt: number } | null> {
  const [cmd, args] = IS_WIN
    ? [
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { [int]((Get-Date) - $p.CreationDate).TotalSeconds; $p.CommandLine }`,
        ],
      ]
    : ['ps', ['-ww', '-o', 'etime=,command=', '-p', String(pid)]];
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const text = stdout.trim();
      const [elapsed, command] = IS_WIN
        ? [text.split(/\r?\n/)[0] ?? '', text.split(/\r?\n/).slice(1).join(' ')]
        : [text.split(/\s+/)[0] ?? '', text.replace(/^\S+\s+/, '')];
      const seconds = IS_WIN ? Number(elapsed) : parseElapsed(elapsed);
      if (seconds === null || !Number.isFinite(seconds) || !command) return resolve(null);
      resolve({ command, startedAt: Date.now() - seconds * 1000 });
    });
  });
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const removeLogs = (log: DaemonLog) => {
  for (const file of log.files) fs.rmSync(file, { force: true });
};

export async function stopDaemons(dir: string, { force = false }: { force?: boolean } = {}): Promise<number[]> {
  const logs = daemonLogs(dir);
  const infos = await Promise.all(logs.map((log) => (isAlive(log.pid) ? processInfo(log.pid) : null)));
  const daemons: DaemonLog[] = [];
  logs.forEach((log, i) => {
    const info = infos[i];
    if (info?.command.includes('GradleDaemon') && info.startedAt <= log.mtimeMs + 2000) daemons.push(log);
    else if (!isAlive(log.pid) || info) removeLogs(log);
  });
  const signal = (pid: number, sig: NodeJS.Signals) => {
    try {
      process.kill(pid, sig);
    } catch {
    }
  };
  for (const { pid } of daemons) signal(pid, force ? 'SIGKILL' : 'SIGTERM');
  const deadline = Date.now() + (force ? 1000 : 5000);
  while (daemons.some((d) => isAlive(d.pid)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  for (const d of daemons) {
    if (isAlive(d.pid)) signal(d.pid, 'SIGKILL');
    removeLogs(d);
  }
  return daemons.map((d) => d.pid);
}
