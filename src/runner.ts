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
  /** 이번 실행 대상은 아니지만 대상이 의존하는 서비스 (--no-deps) */
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
  /** 모든 서비스의 시작 시도가 끝나면(성공·실패 모두) 요약과 함께 resolve된다. */
  ready: Promise<SummaryRow[]>;
  /** 직접 띄운 프로세스가 모두 끝나면 resolve된다. */
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

/** 설정 폴더 기준 상대 경로. 설정 폴더 밖이면 절대 경로를 그대로 보여준다. */
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
      /* 이미 종료됨 */
    }
  }
}

/**
 * 프로세스 그룹에 아직 살아 있는 프로세스가 있는지.
 * dash 같은 셸은 `sh -c`로 받은 명령을 exec하지 않고 자식으로 띄우기 때문에,
 * 셸이 SIGTERM으로 먼저 끝나도 실제 서비스는 같은 그룹에 남아 있을 수 있다.
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
    /* 이미 종료됨 */
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

/** 서비스들을 의존성 순서대로 시작한다. */
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
      logger.error(INFRA, 'docker compose up이 실패했습니다. Docker 실행 여부와 compose 파일을 확인하세요.');
      logger.dumpTail(INFRA);
      return false;
    }
    infraStarted = true;

    // 한 번 실행하고 끝나는 초기화 컨테이너(exit 0)도 성공으로 보도록 상태를 직접 확인한다.
    const startedAt = Date.now();
    const deadline = startedAt + infraConfig.timeout * 1000;
    let lastWaiting = '';
    for (;;) {
      if (stopping) return false;
      let verdict: InfraVerdict;
      try {
        verdict = evaluateInfra(await readInfraState(infraConfig, config.root), infraConfig.services);
      } catch (err) {
        logger.error(INFRA, `컨테이너 상태를 읽지 못했습니다: ${(err as Error).message}`);
        return false;
      }
      if (verdict.failures.length) {
        logger.error(INFRA, `준비되지 않았습니다: ${verdict.failures.join(', ')}`);
        logger.system(`  원인 확인: docker compose logs ${verdict.failures.map((f) => f.split(':')[0]).join(' ')}`);
        return false;
      }
      if (verdict.ready) break;
      const waiting = verdict.waiting.join(', ');
      if (waiting !== lastWaiting) logger.info(INFRA, `대기 중: ${waiting}`);
      lastWaiting = waiting;
      if (Date.now() >= deadline) {
        logger.error(INFRA, `${infraConfig.timeout}초 안에 준비되지 않았습니다: ${waiting}`);
        return false;
      }
      await sleep(1000, abort.signal);
    }
    logger.ok(INFRA, `준비 완료 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    return true;
  }

  async function waitExternal(name: string): Promise<boolean> {
    const svc = service(name);
    if (svc.health.type === 'none') {
      logger.warn(name, '이번 실행에서 제외됐고 헬스체크가 없어 실행 중이라고 가정합니다.');
      set(name, { status: 'external' });
      return true;
    }
    logger.info(name, `외부에서 실행 중인지 확인합니다 (${describeHealth(svc.health)})`);
    const result = await waitHealthy(svc.health, { signal: abort.signal, timeoutMs: externalTimeoutMs });
    if (result === 'healthy') {
      set(name, { status: 'external' });
      logger.ok(name, '외부 실행 확인');
      return true;
    }
    set(name, { status: 'failed' });
    if (result !== 'aborted') {
      logger.error(name, '실행 중이 아닙니다. --no-deps 없이 실행하거나 먼저 띄워 주세요.');
    }
    return false;
  }

  async function launch(name: string): Promise<boolean> {
    const svc = service(name);

    if (svc.port && (await isPortOpen(svc.port))) {
      const who = describeListeners(await findListeners(svc.port));
      if (await checkOnce(svc.health)) {
        set(name, { status: 'external' });
        logger.warn(name, `포트 ${svc.port}에서 이미 실행 중이라 그대로 사용합니다 (${who})`);
        return true;
      }
      set(name, { status: 'failed' });
      logger.error(name, `포트 ${svc.port}를 다른 프로세스가 쓰고 있습니다 (${who}). 종료한 뒤 다시 실행하세요.`);
      return false;
    }
    if (!fs.existsSync(svc.dir)) {
      set(name, { status: 'failed' });
      logger.error(name, `폴더가 없습니다: ${svc.dir}`);
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

    logger.info(name, `시작: ${svc.cmd}  (${displayPath(config.root, svc.dir)})`);
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
        logger.error(name, `실행 실패: ${err.message}`);
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
        logger.error(name, `프로세스가 종료됐습니다 (${signal ?? `code ${code}`})`);
        logger.dumpTail(name);
      }
    });

    const result = await waitHealthy(svc.health, { signal: abort.signal, alive: () => isRunning(child) });
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (result === 'healthy') {
      set(name, { status: 'ready', readySeconds: seconds });
      const address = svc.port ? ` · http://127.0.0.1:${svc.port}` : '';
      logger.ok(name, `준비 완료 ${seconds}s${address}`);
      return true;
    }
    if (result === 'aborted') return false;
    set(name, { status: 'failed' });
    if (result === 'exited') {
      const { code, signal } = await exited;
      logger.error(name, `준비되기 전에 종료됐습니다 (${signal ?? `code ${code}`})`);
    } else {
      logger.error(
        name,
        `${svc.health.timeout}초 안에 준비되지 않았습니다 (${describeHealth(svc.health)}). 프로세스는 계속 실행합니다.`,
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
          logger.warn(name, `건너뜀: 의존 서비스가 준비되지 않았습니다 (${failed.join(', ')})`);
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
    // 셸이 아니라 그룹 전체가 끝났는지를 기준으로 신호를 올린다.
    if (groupAlive(child)) {
      if (force) {
        killGroup(child, 'SIGKILL');
      } else {
        logger.info(name, '종료 중…');
        killGroup(child, 'SIGINT'); // 터미널 Ctrl+C와 같은 신호. Gradle은 이걸 받아야 bootRun을 정리한다.
        if (!(await waitGroupExit(child, svc.stopTimeout * 1000))) {
          killGroup(child, 'SIGTERM');
          if (!(await waitGroupExit(child, 5000))) killGroup(child, 'SIGKILL');
        }
      }
      await waitGroupExit(child, 3000);
    }
    // Gradle 데몬이 띄운 JVM처럼 프로세스 그룹 밖에 남아 포트를 잡고 있는 자식을 정리한다.
    // 시작 전에 포트가 비어 있는 것을 확인했으므로 지금 포트를 잡은 프로세스는 이 서비스가 띄운 것이다.
    if (svc.port && (await isPortOpen(svc.port))) {
      const listeners = await findListeners(svc.port);
      for (const l of listeners) {
        logger.info(name, `포트 ${svc.port}에 남은 PID ${l.pid}(${l.command}) 정리 (Gradle 데몬이 띄운 JVM 등)`);
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
        logger.info(INFRA, '인프라 컨테이너는 계속 실행합니다 (정지: devfleet down)');
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
  waiting: '… 대기',
  starting: '… 시작 중',
  ready: '✔ 준비',
  external: '↺ 기존 실행',
  failed: '✖ 실패',
  skipped: '– 건너뜀',
  crashed: '✖ 종료됨',
  stopped: '■ 정지',
};

export function formatSummary(rows: readonly SummaryRow[]): string {
  const header = ['서비스', '상태', '포트', '준비', 'PID'];
  const body = rows.map((r) => [
    r.name,
    STATUS_LABEL[r.status],
    r.port == null ? '' : String(r.port),
    r.readySeconds == null ? '' : `${r.readySeconds}s`,
    r.pid == null ? '' : String(r.pid),
  ]);
  return formatTable([header, ...body]);
}

/** 한글처럼 두 칸을 차지하는 글자를 고려해 열을 맞춘다. */
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
