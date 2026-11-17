import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readEnvFile } from './config.js';
import { resolveTargets, waves } from './graph.js';
import { isPortOpen, findListeners, describeListeners } from './ports.js';
import { checkOnce, waitHealthy, describeHealth, sleep } from './health.js';
import { Logger } from './logger.js';

const IS_WIN = process.platform === 'win32';
const INFRA = 'infra';

export function planUp(config, names = [], { deps = true } = {}) {
  const targets = resolveTargets(config, names, { withDeps: deps });
  const inTargets = new Set(targets);
  const external = [];
  for (const name of targets) {
    for (const dep of config.services[name].dependsOn) {
      if (!inTargets.has(dep) && !external.includes(dep)) external.push(dep);
    }
  }
  return { targets, external, waves: waves(config.services, targets) };
}

export function infraArgs(config, action, extra = []) {
  return ['compose', ...config.infra.composeFiles.flatMap((f) => ['-f', f]), action, ...extra, ...config.infra.services];
}

function isRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function killGroup(child, signal) {
  try {
    if (IS_WIN) child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* 이미 종료됨 */
    }
  }
}

const within = (promise, ms) => Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);

async function waitPortClosed(port, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await isPortOpen(port))) return true;
    await sleep(200);
  }
  return !(await isPortOpen(port));
}

/**
 * 서비스들을 의존성 순서대로 시작한다.
 * 반환값의 ready는 모든 서비스의 시작 시도가 끝나면(성공·실패 모두) 요약과 함께 resolve된다.
 */
export function startFleet(config, names = [], opts = {}) {
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
  const state = new Map();
  const promises = new Map();
  const abort = new AbortController();
  let stopping = false;
  let stopPromise = null;
  let infraStarted = false;
  let infraChild = null;

  const set = (name, patch) => state.set(name, { ...(state.get(name) ?? {}), ...patch });

  async function startInfra() {
    if (!infra || !config.infra?.services.length) return true;
    const args = infraArgs(config, 'up', ['-d', '--wait']);
    logger.info(INFRA, `docker compose up: ${config.infra.services.join(', ')}`);
    const child = spawn('docker', args, { cwd: config.root, stdio: ['ignore', 'pipe', 'pipe'] });
    infraChild = child;
    logger.attach(INFRA, child.stdout);
    logger.attach(INFRA, child.stderr);
    const code = await new Promise((resolve) => {
      child.once('error', () => resolve(-1));
      child.once('exit', (c) => resolve(c ?? -1));
    });
    infraChild = null;
    if (stopping) return false;
    if (code !== 0) {
      logger.error(INFRA, '인프라를 시작하지 못했습니다. Docker가 실행 중인지 확인하세요.');
      logger.dumpTail(INFRA);
      return false;
    }
    infraStarted = true;
    logger.ok(INFRA, '준비 완료');
    return true;
  }

  async function waitExternal(name) {
    const svc = config.services[name];
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

  async function launch(name) {
    const svc = config.services[name];

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

    let env;
    try {
      env = { ...baseEnv, ...readEnvFile(svc.envFile), ...svc.env };
    } catch (err) {
      set(name, { status: 'failed' });
      logger.error(name, err.message);
      return false;
    }

    const where = path.relative(config.root, svc.dir) || '.';
    logger.info(name, `시작: ${svc.cmd}  (${where})`);
    const child = spawn(svc.cmd, {
      cwd: svc.dir,
      env,
      shell: true,
      detached: !IS_WIN,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    logger.attach(name, child.stdout);
    logger.attach(name, child.stderr);
    const exited = new Promise((resolve) => {
      child.once('error', (err) => {
        logger.error(name, `실행 실패: ${err.message}`);
        resolve({ code: -1, signal: null });
      });
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const startedAt = Date.now();
    set(name, { status: 'starting', child, pid: child.pid, exited, startedAt });

    exited.then(({ code, signal }) => {
      if (stopping) return;
      if (state.get(name).status === 'ready') {
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
      logger.error(name, `${svc.health.timeout}초 안에 준비되지 않았습니다 (${describeHealth(svc.health)}). 프로세스는 계속 실행합니다.`);
    }
    logger.dumpTail(name);
    return false;
  }

  function ensure(name) {
    if (!promises.has(name)) {
      promises.set(
        name,
        (async () => {
          if (!plan.targets.includes(name)) return waitExternal(name);
          const svc = config.services[name];
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
        })(),
      );
    }
    return promises.get(name);
  }

  async function stopOne(name, force) {
    const st = state.get(name);
    if (!st?.child) return;
    const svc = config.services[name];
    const { child, exited } = st;
    if (isRunning(child)) {
      if (force) {
        killGroup(child, 'SIGKILL');
      } else {
        logger.info(name, '종료 중…');
        killGroup(child, 'SIGINT'); // 터미널 Ctrl+C와 같은 신호. Gradle은 이걸 받아야 bootRun을 정리한다.
        if (!(await within(exited, svc.stopTimeout * 1000))) {
          killGroup(child, 'SIGTERM');
          if (!(await within(exited, 5000))) killGroup(child, 'SIGKILL');
        }
      }
      await within(exited, 3000);
    }
    // Gradle 데몬이 띄운 JVM처럼 프로세스 그룹 밖에 남아 포트를 잡고 있는 자식을 정리한다.
    // 시작 전에 포트가 비어 있는 것을 확인했으므로 지금 포트를 잡은 프로세스는 이 서비스가 띄운 것이다.
    if (svc.port && (await isPortOpen(svc.port))) {
      const listeners = await findListeners(svc.port);
      for (const l of listeners) {
        logger.warn(name, `포트 ${svc.port}에 남은 PID ${l.pid}(${l.command})를 종료합니다`);
        try {
          process.kill(l.pid, force ? 'SIGKILL' : 'SIGTERM');
        } catch {
          /* 이미 종료됨 */
        }
      }
      if (!force && listeners.length && !(await waitPortClosed(svc.port, 10_000))) {
        for (const l of listeners) {
          try {
            process.kill(l.pid, 'SIGKILL');
          } catch {
            /* 이미 종료됨 */
          }
        }
      }
    }
    set(name, { status: 'stopped' });
  }

  function stop({ force = false } = {}) {
    if (stopPromise && !force) return stopPromise;
    stopping = true;
    abort.abort();
    if (infraChild) killGroup(infraChild, 'SIGINT');
    stopPromise = (async () => {
      for (const wave of [...plan.waves].reverse()) {
        await Promise.all(wave.map((name) => stopOne(name, force)));
      }
      if (infraStarted && (stopInfra || config.infra?.stopOnExit)) {
        logger.info(INFRA, 'docker compose stop');
        const child = spawn('docker', infraArgs(config, 'stop'), { cwd: config.root, stdio: ['ignore', 'pipe', 'pipe'] });
        logger.attach(INFRA, child.stdout);
        logger.attach(INFRA, child.stderr);
        await new Promise((resolve) => child.once('close', resolve).once('error', resolve));
      } else if (infraStarted) {
        logger.info(INFRA, '인프라 컨테이너는 계속 실행합니다 (정지: devfleet down)');
      }
      await logger.close();
    })();
    return stopPromise;
  }

  const ready = (async () => {
    const infraOk = await startInfra();
    if (!infraOk) {
      for (const name of plan.targets) set(name, { status: 'skipped' });
    } else {
      await Promise.all(plan.targets.map(ensure));
    }
    return summarize();
  })();

  /** 직접 띄운 프로세스가 모두 끝나면 resolve된다. */
  const allExited = ready.then(() =>
    Promise.all([...state.values()].filter((s) => s.exited).map((s) => s.exited)),
  );

  function summarize() {
    return plan.targets.map((name) => {
      const st = state.get(name) ?? {};
      const svc = config.services[name];
      return {
        name,
        status: st.status ?? 'skipped',
        port: svc.port,
        pid: st.child && isRunning(st.child) ? st.pid : null,
        readySeconds: st.readySeconds ?? null,
        logFile: logger.logFile(name),
      };
    });
  }

  return { plan, state, logger, ready, allExited, stop };
}

const STATUS_LABEL = {
  ready: '✔ 준비',
  external: '↺ 기존 실행',
  failed: '✖ 실패',
  skipped: '– 건너뜀',
  crashed: '✖ 종료됨',
  starting: '… 시작 중',
  stopped: '■ 정지',
};

export function formatSummary(rows) {
  const header = ['서비스', '상태', '포트', '준비', 'PID'];
  const body = rows.map((r) => [
    r.name,
    STATUS_LABEL[r.status] ?? r.status,
    r.port ?? '',
    r.readySeconds != null ? `${r.readySeconds}s` : '',
    r.pid ?? '',
  ]);
  const widths = header.map((h, i) => Math.max(displayWidth(h), ...body.map((row) => displayWidth(String(row[i])))));
  const fmt = (row) => row.map((cell, i) => padDisplay(String(cell), widths[i])).join('  ').trimEnd();
  return [fmt(header), ...body.map(fmt)].join('\n');
}

// 한글은 터미널에서 두 칸을 차지하므로 표 정렬에 반영한다.
function displayWidth(text) {
  let width = 0;
  for (const ch of text) width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]/.test(ch) ? 2 : 1;
  return width;
}

function padDisplay(text, width) {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}
