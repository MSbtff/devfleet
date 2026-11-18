import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { readEnvFile } from './config.ts';
import { resolveTargets, waves } from './graph.ts';
import { isPortOpen, findListeners, describeListeners } from './ports.ts';
import { checkOnce, waitHealthy, describeHealth, sleep } from './health.ts';
import { Logger, type Output } from './logger.ts';
import { composeArgs, evaluateInfra, readInfraState, type InfraVerdict } from './infra.ts';
import type { Config } from './types.ts';

const IS_WIN = process.platform === 'win32';
const INFRA = 'infra';

export type Status = 'waiting' | 'starting' | 'ready' | 'external' | 'failed' | 'skipped' | 'crashed' | 'stopped';

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface ServiceState {
  status: Status;
  child?: ChildProcess;
  pid?: number;
  exited?: Promise<ExitInfo>;
  startedAt?: number;
  readySeconds?: string;
}

export interface Plan {
  targets: string[];
  /** Services the targets depend on that are not started in this run (--no-deps) */
  external: string[];
  waves: string[][];
}

export interface UpOptions {
  deps?: boolean;
  infra?: boolean;
  stopInfra?: boolean;
  quiet?: boolean;
  only?: readonly string[] | null;
  out?: Output;
  color?: boolean;
  externalTimeoutMs?: number;
}

export interface SummaryRow {
  name: string;
  status: Status;
  port: number | null;
  pid: number | null;
  readySeconds: string | null;
  logFile: string | null;
}

export interface Fleet {
  plan: Plan;
  state: Map<string, ServiceState>;
  logger: Logger;
  /** Resolves with a summary once every service has finished trying to start (success or failure). */
  ready: Promise<SummaryRow[]>;
  /** Resolves once every process devfleet started has exited. */
  allExited: Promise<unknown>;
  stop(options?: { force?: boolean }): Promise<void>;
}

export function planUp(config: Config, names: readonly string[] = [], { deps = true }: { deps?: boolean } = {}): Plan {
  const targets = resolveTargets(config, names, { withDeps: deps });
  const inTargets = new Set(targets);
  const external: string[] = [];
  for (const name of targets) {
    for (const dep of config.services[name]!.dependsOn) {
      if (!inTargets.has(dep) && !external.includes(dep)) external.push(dep);
    }
  }
  return { targets, external, waves: waves(config.services, targets) };
}

/** Path relative to the config folder, or the absolute path when it is outside. */
export function displayPath(root: string, target: string): string {
  const rel = path.relative(root, target);
  if (!rel) return '.';
  return rel.startsWith('..') || path.isAbsolute(rel) ? target : rel;
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (IS_WIN || child.pid === undefined) child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already exited */
    }
  }
}

/**
 * Whether any process in the group is still alive.
 * Shells such as dash run the `sh -c` command as a child instead of exec-ing it,
 * so the service can stay in the group after the shell itself exits on SIGTERM.
 */
function groupAlive(child: ChildProcess): boolean {
  if (IS_WIN || child.pid === undefined) return isRunning(child);
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitGroupExit(child: ChildProcess, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (groupAlive(child)) {
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
  return true;
}

function killPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* already exited */
  }
}

async function waitPortClosed(port: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await isPortOpen(port))) return true;
    await sleep(200);
  }
  return !(await isPortOpen(port));
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.once('error', () => resolve(-1));
    child.once('exit', (code) => resolve(code ?? -1));
  });
}

/** Starts services in dependency order. */
export function startFleet(config: Config, names: readonly string[] = [], opts: UpOptions = {}): Fleet {
  const {
    deps = true,
    infra = true,
    stopInfra = false,
    quiet = false,
    only = null,
    out = process.stdout,
    color,
    externalTimeoutMs = 30_000,
  } = opts;
  const plan = planUp(config, names, { deps });
  const logger = new Logger({
    out,
    color,
    names: [...plan.targets, ...plan.external, INFRA],
    logDir: config.logDir,
    quiet,
    only,
  });
  const baseEnv = { ...process.env, ...readEnvFile(config.envFile), ...config.env };
  const state = new Map<string, ServiceState>();
  const promises = new Map<string, Promise<boolean>>();
  const abort = new AbortController();
  let stopping = false;
  let stopPromise: Promise<void> | null = null;
  let infraStarted = false;
  let infraChild: ChildProcess | null = null;

  const set = (name: string, patch: Partial<ServiceState>) =>
    state.set(name, { status: 'waiting', ...state.get(name), ...patch });
  const service = (name: string) => config.services[name]!;

  async function startInfra(): Promise<boolean> {
    const infraConfig = config.infra;
    if (!infra || !infraConfig?.services.length) return true;
    logger.info(INFRA, `docker compose up: ${infraConfig.services.join(', ')}`);
    const child = spawn('docker', composeArgs(infraConfig, 'up', ['-d']), {
      cwd: config.root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    infraChild = child;
    logger.attach(INFRA, child.stdout);
    logger.attach(INFRA, child.stderr);
    const code = await waitForExit(child);
    infraChild = null;
    if (stopping) return false;
    if (code !== 0) {
      logger.error(INFRA, 'docker compose up failed. Check that Docker is running and the compose file is valid.');
      logger.dumpTail(INFRA);
      return false;
    }
    infraStarted = true;

    // Read container states directly so one-shot init containers that exit 0 count as ready.
    const startedAt = Date.now();
    const deadline = startedAt + infraConfig.timeout * 1000;
    let lastWaiting = '';
    for (;;) {
      if (stopping) return false;
      let verdict: InfraVerdict;
      try {
        verdict = evaluateInfra(await readInfraState(infraConfig, config.root), infraConfig.services);
      } catch (err) {
        logger.error(INFRA, `could not read container state: ${(err as Error).message}`);
        return false;
      }
      if (verdict.failures.length) {
        logger.error(INFRA, `not ready: ${verdict.failures.join(', ')}`);
        logger.system(`  To investigate: docker compose logs ${verdict.failures.map((f) => f.split(':')[0]).join(' ')}`);
        return false;
      }
      if (verdict.ready) break;
      const waiting = verdict.waiting.join(', ');
      if (waiting !== lastWaiting) logger.info(INFRA, `waiting for: ${waiting}`);
      lastWaiting = waiting;
      if (Date.now() >= deadline) {
        logger.error(INFRA, `not ready after ${infraConfig.timeout}s: ${waiting}`);
        return false;
      }
      await sleep(1000, abort.signal);
    }
    logger.ok(INFRA, `ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    return true;
  }

  async function waitExternal(name: string): Promise<boolean> {
    const svc = service(name);
    if (svc.health.type === 'none') {
      logger.warn(name, 'not started in this run and has no health check; assuming it is running');
      set(name, { status: 'external' });
      return true;
    }
    logger.info(name, `checking that it is already running (${describeHealth(svc.health)})`);
    const result = await waitHealthy(svc.health, { signal: abort.signal, timeoutMs: externalTimeoutMs });
    if (result === 'healthy') {
      set(name, { status: 'external' });
      logger.ok(name, 'already running');
      return true;
    }
    set(name, { status: 'failed' });
    if (result !== 'aborted') {
      logger.error(name, 'is not running. Start it first, or run without --no-deps.');
    }
    return false;
  }

  async function launch(name: string): Promise<boolean> {
    const svc = service(name);

    if (svc.port && (await isPortOpen(svc.port))) {
      const who = describeListeners(await findListeners(svc.port));
      if (await checkOnce(svc.health)) {
        set(name, { status: 'external' });
        logger.warn(name, `already running on port ${svc.port}; reusing it (${who})`);
        return true;
      }
      set(name, { status: 'failed' });
      logger.error(name, `port ${svc.port} is in use by another process (${who}). Stop it and try again.`);
      return false;
    }
    if (!fs.existsSync(svc.dir)) {
      set(name, { status: 'failed' });
      logger.error(name, `directory not found: ${svc.dir}`);
      return false;
    }

    let env: NodeJS.ProcessEnv;
    try {
      env = { ...baseEnv, ...readEnvFile(svc.envFile), ...svc.env };
    } catch (err) {
      set(name, { status: 'failed' });
      logger.error(name, (err as Error).message);
      return false;
    }

    logger.info(name, `starting: ${svc.cmd}  (${displayPath(config.root, svc.dir)})`);
    const child = spawn(svc.cmd, {
      cwd: svc.dir,
      env,
      shell: true,
      detached: !IS_WIN,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    logger.attach(name, child.stdout);
    logger.attach(name, child.stderr);
    const exited = new Promise<ExitInfo>((resolve) => {
      child.once('error', (err) => {
        logger.error(name, `failed to start: ${err.message}`);
        resolve({ code: -1, signal: null });
      });
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const startedAt = Date.now();
    set(name, { status: 'starting', child, pid: child.pid, exited, startedAt });

    void exited.then(({ code, signal }) => {
      if (stopping) return;
      if (state.get(name)?.status === 'ready') {
        set(name, { status: 'crashed' });
        logger.error(name, `exited (${signal ?? `code ${code}`})`);
        logger.dumpTail(name);
      }
    });

    const result = await waitHealthy(svc.health, { signal: abort.signal, alive: () => isRunning(child) });
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (result === 'healthy') {
      set(name, { status: 'ready', readySeconds: seconds });
      const address = svc.port ? ` · http://127.0.0.1:${svc.port}` : '';
      logger.ok(name, `ready in ${seconds}s${address}`);
      return true;
    }
    if (result === 'aborted') return false;
    set(name, { status: 'failed' });
    if (result === 'exited') {
      const { code, signal } = await exited;
      logger.error(name, `exited before becoming ready (${signal ?? `code ${code}`})`);
    } else {
      logger.error(
        name,
        `not ready after ${svc.health.timeout}s (${describeHealth(svc.health)}). Leaving the process running.`,
      );
    }
    logger.dumpTail(name);
    return false;
  }

  function ensure(name: string): Promise<boolean> {
    let promise = promises.get(name);
    if (!promise) {
      promise = (async () => {
        if (!plan.targets.includes(name)) return waitExternal(name);
        const svc = service(name);
        set(name, { status: 'waiting' });
        const results = await Promise.all(svc.dependsOn.map(ensure));
        if (stopping) {
          set(name, { status: 'skipped' });
          return false;
        }
        const failed = svc.dependsOn.filter((_, i) => !results[i]);
        if (failed.length) {
          set(name, { status: 'skipped' });
          logger.warn(name, `skipped: dependencies are not ready (${failed.join(', ')})`);
          return false;
        }
        return launch(name);
      })();
      promises.set(name, promise);
    }
    return promise;
  }

  async function stopOne(name: string, force: boolean): Promise<void> {
    const st = state.get(name);
    if (!st?.child || !st.exited) return;
    const svc = service(name);
    const { child } = st;
    // Escalate based on the whole process group, not just the shell.
    if (groupAlive(child)) {
      if (force) {
        killGroup(child, 'SIGKILL');
      } else {
        logger.info(name, 'stopping…');
        killGroup(child, 'SIGINT'); // Same signal as Ctrl+C in a terminal. Gradle needs it to shut bootRun down cleanly.
        if (!(await waitGroupExit(child, svc.stopTimeout * 1000))) {
          killGroup(child, 'SIGTERM');
          if (!(await waitGroupExit(child, 5000))) killGroup(child, 'SIGKILL');
        }
      }
      await waitGroupExit(child, 3000);
    }
    // Clean up children outside the process group that still hold the port, such as JVMs forked by the Gradle daemon.
    // The port was free before start, so whatever holds it now was started by this service.
    if (svc.port && (await isPortOpen(svc.port))) {
      const listeners = await findListeners(svc.port);
      for (const l of listeners) {
        logger.info(name, `stopping PID ${l.pid} (${l.command}) left on port ${svc.port} (e.g. a JVM forked by the Gradle daemon)`);
        killPid(l.pid, force ? 'SIGKILL' : 'SIGTERM');
      }
      if (!force && listeners.length && !(await waitPortClosed(svc.port, 10_000))) {
        for (const l of listeners) killPid(l.pid, 'SIGKILL');
      }
    }
    set(name, { status: 'stopped' });
  }

  function stop({ force = false }: { force?: boolean } = {}): Promise<void> {
    if (stopPromise && !force) return stopPromise;
    stopping = true;
    abort.abort();
    if (infraChild) killGroup(infraChild, 'SIGINT');
    stopPromise = (async () => {
      for (const wave of [...plan.waves].reverse()) {
        await Promise.all(wave.map((name) => stopOne(name, force)));
      }
      const infraConfig = config.infra;
      if (infraStarted && infraConfig && (stopInfra || infraConfig.stopOnExit)) {
        logger.info(INFRA, 'docker compose stop');
        const child = spawn('docker', composeArgs(infraConfig, 'stop'), {
          cwd: config.root,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        logger.attach(INFRA, child.stdout);
        logger.attach(INFRA, child.stderr);
        await waitForExit(child);
      } else if (infraStarted) {
        logger.info(INFRA, 'leaving infra containers running (stop them with: devfleet down)');
      }
      await logger.close();
    })();
    return stopPromise;
  }

  function summarize(): SummaryRow[] {
    return plan.targets.map((name) => {
      const st = state.get(name);
      return {
        name,
        status: st?.status ?? 'skipped',
        port: service(name).port,
        pid: st?.child && isRunning(st.child) ? (st.pid ?? null) : null,
        readySeconds: st?.readySeconds ?? null,
        logFile: logger.logFile(name),
      };
    });
  }

  const ready = (async () => {
    if (await startInfra()) {
      await Promise.all(plan.targets.map(ensure));
    } else {
      for (const name of plan.targets) set(name, { status: 'skipped' });
    }
    return summarize();
  })();

  const allExited = ready.then(() =>
    Promise.all([...state.values()].flatMap((s) => (s.exited ? [s.exited] : []))),
  );

  return { plan, state, logger, ready, allExited, stop };
}

const STATUS_LABEL: Record<Status, string> = {
  waiting: '… waiting',
  starting: '… starting',
  ready: '✔ ready',
  external: '↺ external',
  failed: '✖ failed',
  skipped: '– skipped',
  crashed: '✖ crashed',
  stopped: '■ stopped',
};

export function formatSummary(rows: readonly SummaryRow[]): string {
  const header = ['SERVICE', 'STATUS', 'PORT', 'READY', 'PID'];
  const body = rows.map((r) => [
    r.name,
    STATUS_LABEL[r.status],
    r.port == null ? '' : String(r.port),
    r.readySeconds == null ? '' : `${r.readySeconds}s`,
    r.pid == null ? '' : String(r.pid),
  ]);
  return formatTable([header, ...body]);
}

/** Aligns columns, counting wide characters such as Hangul as two cells. */
export function formatTable(rows: readonly (readonly string[])[]): string {
  const columns = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: columns }, (_, i) => Math.max(...rows.map((r) => displayWidth(r[i] ?? ''))));
  return rows
    .map((row) =>
      row
        .map((cell, i) => cell + ' '.repeat(Math.max(0, (widths[i] ?? 0) - displayWidth(cell))))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]/.test(ch) ? 2 : 1;
  return width;
}
