import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { readEnvFile } from './config.ts';
import { resolveTargets, waves } from './graph.ts';
import { isPortOpen, findListeners, describeListeners } from './ports.ts';
import { checkOnce, waitHealthy, describeHealth, sleep } from './health.ts';
import { Logger, type Output } from './logger.ts';
import { stopDaemons, withDaemonRegistry } from './gradle.ts';
import { composeArgs, evaluateInfra, readInfraState, type InfraVerdict } from './infra.ts';
import type { Config } from './types.ts';

const IS_WIN = process.platform === 'win32';
const INFRA = 'infra';

export type Status =
  | 'waiting'
  | 'building'
  | 'starting'
  | 'ready'
  | 'external'
  | 'failed'
  | 'skipped'
  | 'crashed'
  | 'restarting'
  | 'stopping'
  | 'stopped';

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
  /** When the current process became ready */
  readyAt?: number;
  /** Automatic restarts so far in this run */
  restarts?: number;
  /** Automatic restarts in a row since the service last stayed up */
  attempts?: number;
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
  /** Delay before the first automatic restart; doubles with each attempt in a row */
  restartDelayMs?: number;
  /** Run each service's build before starting it (default true) */
  build?: boolean;
}

export interface RestartOptions {
  /** Run the service's build first (default true) */
  build?: boolean;
}

export interface SummaryRow {
  name: string;
  status: Status;
  port: number | null;
  pid: number | null;
  readySeconds: string | null;
  logFile: string | null;
  /** Automatic restarts so far in this run (missing in replies from devfleet 0.2.0) */
  restarts?: number;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export interface Fleet {
  plan: Plan;
  state: Map<string, ServiceState>;
  logger: Logger;
  /** Resolves with a summary once every service has finished trying to start (success or failure). */
  ready: Promise<SummaryRow[]>;
  /**
   * Resolves once no process devfleet started is running any more.
   * A service stopped on request (`devfleet stop`) keeps the fleet open so it can be restarted.
   */
  allExited: Promise<void>;
  /** Current status of every service in this run. */
  summarize(): SummaryRow[];
  /**
   * Rebuilds the services that have a build, then stops them (dependents first) and starts them again
   * in dependency order. A service whose build fails keeps running as it was.
   */
  restart(names: readonly string[], options?: RestartOptions): Promise<ActionResult>;
  /** Stops the services, dependents first. Services that depend on them keep running. */
  stopServices(names: readonly string[]): Promise<ActionResult>;
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

const RESTART_RESET_MS = 60_000;
const MAX_RESTART_DELAY_MS = 30_000;

/** Newest file matching `pattern` (relative to dir, `*` and `?` in the file name), skipping plain, sources, and javadoc jars. */
export function findJar(dir: string, pattern: string): string | null {
  const folder = path.resolve(dir, path.dirname(pattern));
  const base = path.basename(pattern);
  const regex = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  let entries: string[];
  try {
    entries = fs.readdirSync(folder);
  } catch {
    return null;
  }
  const candidates = entries
    .filter((f) => regex.test(f) && !/-(plain|sources|javadoc)\.jar$/.test(f))
    .flatMap((f) => {
      const stat = fs.statSync(path.join(folder, f), { throwIfNoEntry: false });
      return stat?.isFile() ? [{ file: path.join(folder, f), mtime: stat.mtimeMs }] : [];
    })
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.file ?? null;
}

function shellQuote(arg: string): string {
  if (IS_WIN) return `"${arg}"`;
  return /^[A-Za-z0-9_./:=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** java from JAVA_HOME when it is set, otherwise from PATH. */
function javaCommand(env: NodeJS.ProcessEnv, javaOpts: string, jar: string): string {
  const java = env.JAVA_HOME ? path.join(env.JAVA_HOME, 'bin', 'java') : 'java';
  return [shellQuote(java), javaOpts.trim(), '-jar', shellQuote(jar)].filter(Boolean).join(' ');
}

/** The command a service runs, as shown in plans: the shell command, or java -jar for a jar. */
export function describeCommand(svc: Pick<Config['services'][string], 'cmd' | 'jar' | 'javaOpts'>): string {
  return svc.jar ? ['java', svc.javaOpts.trim(), '-jar', svc.jar].filter(Boolean).join(' ') : svc.cmd;
}

function formatSeconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(1))}s`;
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
    restartDelayMs = 1000,
    build: buildFirst = true,
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
  let startupDone = false;
  /** Services a restart or stop request is working on */
  const busy = new Set<string>();
  /** Build processes that are running, so a shutdown can stop them */
  const builds = new Set<ChildProcess>();
  let buildSlots = config.buildConcurrency;
  const buildQueue: (() => void)[] = [];
  /** Builds that have been asked for and not finished, including those waiting for a slot */
  let pendingBuilds = 0;
  /** Builds use their own Gradle daemon registry here, so their daemons can be stopped once the builds are done. */
  const daemonDir = config.gradleDaemon === 'stop' ? path.join(config.root, '.devfleet', 'gradle-daemons') : null;
  let daemonStop: Promise<void> | null = null;
  /** Automatic restarts in progress, so a restart or stop request can cancel them */
  const autoRestarts = new Map<string, { cancel: AbortController; done: Promise<void> }>();
  let resolveAllExited!: () => void;
  const allExited = new Promise<void>((resolve) => (resolveAllExited = resolve));

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
      env = serviceEnv(name);
    } catch (err) {
      set(name, { status: 'failed' });
      logger.error(name, (err as Error).message);
      return false;
    }

    let cmd = svc.cmd;
    if (svc.jar) {
      const jar = findJar(svc.dir, svc.jar);
      if (!jar) {
        set(name, { status: 'failed' });
        const hint = svc.build ? '' : ' Build it first, or add a build command.';
        logger.error(name, `no jar matches ${svc.jar} in ${displayPath(config.root, svc.dir)}.${hint}`);
        return false;
      }
      // Run a copy, so a later build can overwrite the original while this process keeps running.
      const runJar = path.join(config.root, '.devfleet', 'jars', `${name}.jar`);
      try {
        fs.mkdirSync(path.dirname(runJar), { recursive: true });
        fs.copyFileSync(jar, `${runJar}.tmp`);
        fs.renameSync(`${runJar}.tmp`, runJar);
      } catch (err) {
        set(name, { status: 'failed' });
        logger.error(name, `could not copy ${displayPath(config.root, jar)}: ${(err as Error).message}`);
        return false;
      }
      cmd = javaCommand(env, svc.javaOpts, runJar);
      logger.info(name, `running ${displayPath(config.root, jar)} as ${displayPath(config.root, runJar)}`);
    }

    logger.info(name, `starting: ${cmd}  (${displayPath(config.root, svc.dir)})`);
    const child = spawn(cmd, {
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
    set(name, { status: 'starting', child, pid: child.pid, exited, startedAt, readySeconds: undefined });

    void exited.then(({ code, signal }) => {
      if (stopping) return;
      // A restart replaces the child; only the current one can crash.
      if (state.get(name)?.child === child && state.get(name)?.status === 'ready') {
        set(name, { status: 'crashed' });
        logger.error(name, `exited (${signal ?? `code ${code}`})`);
        logger.dumpTail(name);
        if (svc.restart === 'on-failure') autoRestart(name);
      }
      checkAllExited();
    });

    const result = await waitHealthy(svc.health, { signal: abort.signal, alive: () => isRunning(child) });
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (result === 'healthy') {
      set(name, { status: 'ready', readySeconds: seconds, readyAt: Date.now() });
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

  function serviceEnv(name: string): NodeJS.ProcessEnv {
    const svc = service(name);
    return { ...baseEnv, ...readEnvFile(svc.envFile), ...svc.env };
  }

  async function buildSlot(): Promise<void> {
    while (buildSlots === 0) await new Promise<void>((resolve) => buildQueue.push(resolve));
    buildSlots -= 1;
  }

  function releaseBuildSlot(): void {
    buildSlots += 1;
    buildQueue.shift()?.();
  }

  /**
   * Runs the service's build. Builds wait for a free slot (build_concurrency, default 1), so with Gradle
   * one daemon is reused instead of each service keeping its own.
   * `mark` shows the service as building; a restart leaves the running service's status alone.
   */
  async function buildService(name: string, mark: boolean): Promise<boolean> {
    const svc = service(name);
    const build = svc.build!;
    pendingBuilds += 1;
    await buildSlot();
    try {
      if (daemonStop) await daemonStop; // don't hand the build a daemon that is shutting down
      if (stopping) return false;
      let env: NodeJS.ProcessEnv;
      try {
        env = serviceEnv(name);
        if (daemonDir) env = withDaemonRegistry(env, daemonDir);
      } catch (err) {
        logger.error(name, (err as Error).message);
        return false;
      }
      if (!fs.existsSync(build.dir)) {
        logger.error(name, `build directory not found: ${build.dir}`);
        return false;
      }
      if (mark && state.get(name)?.status === 'waiting') set(name, { status: 'building' });
      logger.info(name, `building: ${build.cmd}  (${displayPath(config.root, build.dir)})`);
      const startedAt = Date.now();
      const child = spawn(build.cmd, {
        cwd: build.dir,
        env,
        shell: true,
        detached: !IS_WIN,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      builds.add(child);
      logger.attach(name, child.stdout);
      logger.attach(name, child.stderr);
      const code = await waitForExit(child);
      builds.delete(child);
      if (state.get(name)?.status === 'building') set(name, { status: 'waiting' });
      if (stopping) return false;
      if (code !== 0) {
        logger.error(name, `build failed (${code === -1 ? 'could not run it' : `code ${code}`})`);
        logger.dumpTail(name);
        return false;
      }
      logger.ok(name, `built in ${formatSeconds(Date.now() - startedAt)}`);
      return true;
    } finally {
      releaseBuildSlot();
      pendingBuilds -= 1;
      // Wait a tick: the next build in a restart is asked for right after this one finishes.
      if (pendingBuilds === 0) setTimeout(() => void stopBuildDaemons(), 0);
    }
  }

  /** Stops the Gradle daemons the builds started, once no build is running or waiting (gradle_daemon: stop). */
  function stopBuildDaemons({ force = false, shutdown = false } = {}): Promise<void> {
    if (!daemonDir) return Promise.resolve();
    if (daemonStop) return daemonStop;
    if (!shutdown && (pendingBuilds || stopping)) return Promise.resolve();
    daemonStop = (async () => {
      const pids = await stopDaemons(daemonDir, { force });
      if (pids.length) {
        const which = pids.length === 1 ? 'the Gradle daemon' : `${pids.length} Gradle daemons`;
        const them = pids.length === 1 ? 'it' : 'them';
        logger.system(`stopped ${which} the builds used (PID ${pids.join(', ')}) to free memory; set gradle_daemon: keep to keep ${them}`);
      }
    })().finally(() => {
      daemonStop = null;
    });
    return daemonStop;
  }

  function ensure(name: string): Promise<boolean> {
    let promise = promises.get(name);
    if (!promise) {
      promise = (async () => {
        if (!plan.targets.includes(name)) return waitExternal(name);
        const svc = service(name);
        set(name, { status: 'waiting' });
        // Builds start right away, in start order, while dependencies are still coming up.
        const built = buildFirst && svc.build ? buildService(name, true) : Promise.resolve(true);
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
        if (!(await built)) {
          set(name, { status: 'failed' });
          return false;
        }
        if (stopping) {
          set(name, { status: 'skipped' });
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
    set(name, { status: 'stopping' });
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
    for (const child of builds) killGroup(child, force ? 'SIGKILL' : 'SIGINT');
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
      // Builds cut short by the shutdown leave their daemon behind too.
      await daemonStop;
      await stopBuildDaemons({ force, shutdown: true });
      await logger.close();
      resolveAllExited();
    })();
    return stopPromise;
  }

  function checkAllExited(): void {
    if (!startupDone || busy.size || autoRestarts.size) return;
    const states = [...state.values()];
    if (states.some((s) => s.child && isRunning(s.child))) return;
    if (states.some((s) => s.status === 'stopped')) return;
    resolveAllExited();
  }

  /** Why the services can't be restarted or stopped right now, or null. */
  function refuse(names: readonly string[]): string | null {
    if (stopping) return 'devfleet is shutting down';
    if (!names.length) return 'no services given';
    const unknown = names.filter((n) => !config.services[n]);
    if (unknown.length) return `Unknown service: ${unknown.join(', ')}`;
    const outside = names.filter((n) => !plan.targets.includes(n));
    if (outside.length) {
      return `not started by this devfleet up: ${outside.join(', ')} (it only manages ${plan.targets.join(', ')})`;
    }
    if (!startupDone) return 'still starting up; try again once every service has finished starting';
    const inUse = names.filter((n) => busy.has(n));
    if (inUse.length) return `already being restarted or stopped: ${inUse.join(', ')}`;
    return null;
  }

  /** The given services grouped into this run's start waves, in start order. */
  function wavesOf(names: readonly string[]): string[][] {
    return plan.waves.map((wave) => wave.filter((n) => names.includes(n))).filter((wave) => wave.length);
  }

  async function withBusy(names: readonly string[], action: () => Promise<ActionResult>): Promise<ActionResult> {
    const error = refuse(names);
    if (error) return { ok: false, error };
    for (const name of names) busy.add(name);
    try {
      // A request takes over from an automatic restart, e.g. to stop a service that keeps crashing.
      await Promise.all(
        names.map((name) => {
          const auto = autoRestarts.get(name);
          if (!auto) return;
          logger.info(name, 'cancelling the automatic restart');
          auto.cancel.abort();
          return auto.done;
        }),
      );
      if (stopping) return { ok: false, error: 'devfleet is shutting down' };
      return await action();
    } finally {
      for (const name of names) busy.delete(name);
      checkAllExited();
    }
  }

  function stopServices(names: readonly string[]): Promise<ActionResult> {
    const unique = [...new Set(names)];
    return withBusy(unique, async () => {
      for (const wave of wavesOf(unique).reverse()) {
        await Promise.all(wave.map((name) => stopOne(name, false)));
      }
      return { ok: true };
    });
  }

  /** Starts a stopped service again if its dependencies are ready. */
  async function startAgain(name: string): Promise<boolean> {
    if (stopping) return false;
    const notReady = service(name).dependsOn.filter((dep) => {
      const status = state.get(dep)?.status;
      return status !== 'ready' && status !== 'external';
    });
    if (notReady.length) {
      set(name, { status: 'skipped' });
      logger.warn(name, `not started: dependencies are not ready (${notReady.join(', ')})`);
      return false;
    }
    return launch(name);
  }

  /**
   * Restarts a service that crashed after becoming ready (restart: on-failure).
   * Waits restartDelayMs, then twice as long for each further attempt in a row, up to 30 seconds.
   * A service that stayed up for a minute before crashing gets its full max_restarts again.
   */
  function autoRestart(name: string): void {
    // A restart or stop request is already handling it.
    if (busy.has(name) || autoRestarts.has(name) || stopping) return;
    const cancel = new AbortController();
    const onStop = () => cancel.abort();
    abort.signal.addEventListener('abort', onStop, { once: true });
    const done = runAutoRestart(name, cancel.signal).finally(() => {
      abort.signal.removeEventListener('abort', onStop);
      autoRestarts.delete(name);
      checkAllExited();
    });
    autoRestarts.set(name, { cancel, done });
  }

  async function runAutoRestart(name: string, cancelled: AbortSignal): Promise<void> {
    const svc = service(name);
    const st = state.get(name);
    let attempts = st?.readyAt && Date.now() - st.readyAt >= RESTART_RESET_MS ? 0 : (st?.attempts ?? 0);
    try {
      while (!cancelled.aborted) {
        if (attempts >= svc.maxRestarts) {
          logger.error(name, `not restarting: gave up after ${attempts} automatic restart(s) (max_restarts: ${svc.maxRestarts})`);
          set(name, { status: 'crashed' });
          return;
        }
        attempts += 1;
        const delay = Math.min(restartDelayMs * 2 ** (attempts - 1), MAX_RESTART_DELAY_MS);
        set(name, { status: 'restarting', attempts, restarts: (state.get(name)?.restarts ?? 0) + 1 });
        logger.warn(name, `restarting in ${formatSeconds(delay)} (attempt ${attempts}/${svc.maxRestarts})`);
        await sleep(delay, cancelled);
        if (cancelled.aborted) return;
        await stopOne(name, false); // clears anything the crashed process left on the port
        if (cancelled.aborted) return;
        if (await startAgain(name)) return;
      }
    } finally {
      set(name, { attempts });
      if (cancelled.aborted && state.get(name)?.status === 'restarting') set(name, { status: 'crashed' });
    }
  }

  function restart(names: readonly string[], { build = true }: RestartOptions = {}): Promise<ActionResult> {
    const unique = [...new Set(names)];
    return withBusy(unique, async () => {
      // Build before stopping anything, so a failed build leaves the running process alone.
      const buildFailed: string[] = [];
      if (build) {
        const toBuild = wavesOf(unique.filter((n) => service(n).build)).flat();
        const results = await Promise.all(toBuild.map((name) => buildService(name, false)));
        if (stopping) return { ok: false, error: 'devfleet is shutting down' };
        toBuild.forEach((name, i) => {
          if (results[i]) return;
          buildFailed.push(name);
          const running = state.get(name)?.child && isRunning(state.get(name)!.child!);
          logger.warn(name, running ? 'not restarting: the build failed, so the running process is kept' : 'not restarting: the build failed');
        });
      }
      const groups = wavesOf(unique.filter((n) => !buildFailed.includes(n)));
      for (const wave of [...groups].reverse()) {
        await Promise.all(wave.map((name) => stopOne(name, false)));
      }
      const failed: string[] = [];
      for (const wave of groups) {
        await Promise.all(
          wave.map(async (name) => {
            if (await startAgain(name)) set(name, { attempts: 0 });
            else failed.push(name);
          }),
        );
      }
      if (stopping) return { ok: false, error: 'devfleet is shutting down' };
      const problems = [
        ...(buildFailed.length ? [`build failed: ${buildFailed.join(', ')}`] : []),
        ...(failed.length ? [`not ready: ${failed.join(', ')}`] : []),
      ];
      return problems.length ? { ok: false, error: problems.join('; ') } : { ok: true };
    });
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
        restarts: st?.restarts ?? 0,
      };
    });
  }

  const ready = (async () => {
    if (await startInfra()) {
      await Promise.all(plan.targets.map(ensure));
    } else {
      for (const name of plan.targets) set(name, { status: 'skipped' });
    }
    startupDone = true;
    checkAllExited();
    return summarize();
  })();

  return { plan, state, logger, ready, allExited, summarize, restart, stopServices, stop };
}

const STATUS_LABEL: Record<Status, string> = {
  waiting: '… waiting',
  building: '… building',
  starting: '… starting',
  ready: '✔ ready',
  external: '↺ external',
  failed: '✖ failed',
  skipped: '– skipped',
  crashed: '✖ crashed',
  restarting: '↻ restarting',
  stopping: '… stopping',
  stopped: '■ stopped',
};

export function statusLabel(status: Status): string {
  return STATUS_LABEL[status];
}

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
