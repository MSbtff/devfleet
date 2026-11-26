import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

// Gradle keeps a daemon in memory after a build (three hours by default). devfleet points its builds at a
// daemon registry of their own, so those daemons are never shared with an IDE or a `bootRun` service and
// can be stopped once the builds are done without touching anyone else's.

const REGISTRY_PROPERTY = 'org.gradle.daemon.registry.base';
const LOG_FILE = /^daemon-(\d+)\.out\.log$/;

/** Adds the daemon registry to GRADLE_OPTS, which only the Gradle client reads, so other build tools ignore it. */
export function withDaemonRegistry(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const option = /\s/.test(dir) ? `"-D${REGISTRY_PROPERTY}=${dir}"` : `-D${REGISTRY_PROPERTY}=${dir}`;
  return { ...env, GRADLE_OPTS: env.GRADLE_OPTS ? `${env.GRADLE_OPTS} ${option}` : option };
}

/** PIDs of daemons that wrote a log in the registry (`<dir>/<gradle version>/daemon-<pid>.out.log`). Some may have exited. */
function loggedPids(dir: string): number[] {
  const pids: number[] = [];
  let versions: string[];
  try {
    versions = fs.readdirSync(dir);
  } catch {
    return pids;
  }
  for (const version of versions) {
    let files: string[];
    try {
      files = fs.readdirSync(path.join(dir, version));
    } catch {
      continue;
    }
    for (const file of files) {
      const match = LOG_FILE.exec(file);
      if (match) pids.push(Number(match[1]));
    }
  }
  return pids;
}

/** The command line of a running process, or null if it is gone or can't be read. */
function commandLine(pid: number): Promise<string | null> {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`]]
      : ['ps', ['-o', 'command=', '-p', String(pid)]];
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout) => resolve(err ? null : stdout.trim() || null));
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

/**
 * Stops the Gradle daemons registered in `dir` and resolves with their PIDs.
 * Old logs stay behind after a daemon exits and the PID may since belong to something else,
 * so a PID is only stopped while its command line still says GradleDaemon.
 */
export async function stopDaemons(dir: string, { force = false }: { force?: boolean } = {}): Promise<number[]> {
  const candidates = loggedPids(dir).filter(isAlive);
  const commands = await Promise.all(candidates.map(commandLine));
  const daemons = candidates.filter((_, i) => commands[i]?.includes('GradleDaemon'));
  const signal = (pid: number, sig: NodeJS.Signals) => {
    try {
      process.kill(pid, sig);
    } catch {
      /* already exited */
    }
  };
  for (const pid of daemons) signal(pid, force ? 'SIGKILL' : 'SIGTERM');
  const deadline = Date.now() + 5000;
  while (daemons.some(isAlive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  for (const pid of daemons.filter(isAlive)) signal(pid, 'SIGKILL');
  return daemons;
}
