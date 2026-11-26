import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseArgs } from '../src/args.ts';
import { isPortOpen } from '../src/ports.ts';
import { CLI, fake, freePort, tempDir } from './helpers.ts';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** CLI를 실행하고 끝날 때까지 기다린다. */
function run(args: string[], cwd: string, timeout = 30_000): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`시간 초과: devfleet ${args.join(' ')}\n${stdout}${stderr}`));
    }, timeout);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

interface Running {
  child: ChildProcess;
  output: () => string;
  waitFor: (pattern: RegExp, timeout?: number) => Promise<void>;
  exited: Promise<number | null>;
}

/** 오래 실행되는 `devfleet up`을 띄우고 출력을 지켜본다. */
function start(args: string[], cwd: string): Running {
  const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' } });
  let text = '';
  const listeners = new Set<() => void>();
  const onData = (c: Buffer) => {
    text += c;
    for (const fn of listeners) fn();
  };
  child.stdout!.on('data', onData);
  child.stderr!.on('data', onData);
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const waitFor = (pattern: RegExp, timeout = 20_000) =>
    new Promise<void>((resolve, reject) => {
      const check = () => {
        if (!pattern.test(text)) return;
        listeners.delete(check);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`${pattern} 출력을 기다리다 시간 초과\n${text}`));
      }, timeout);
      listeners.add(check);
      check();
    });
  return { child, output: () => text, waitFor, exited };
}

/** devfleet.yaml을 쓴 임시 프로젝트 폴더. JSON은 그대로 유효한 YAML이다. */
function project(config: Record<string, unknown>): string {
  const root = tempDir('devfleet-cli-');
  fs.writeFileSync(path.join(root, 'devfleet.yaml'), JSON.stringify(config, null, 2));
  return root;
}

// ---------------------------------------------------------------- parseArgs

test('parseArgs: 위치 인자, 긴/짧은 옵션, 별칭, --no-*, --', () => {
  assert.deepEqual(parseArgs(['up', 'a', 'b', '-q', '--no-deps', '--only=x,y', '-c', 'f.yaml', '--', '--raw']), {
    _: ['up', 'a', 'b', '--raw'],
    quiet: true,
    deps: false,
    only: 'x,y',
    config: 'f.yaml',
  });
  assert.deepEqual(parseArgs(['logs', 'svc', '-f', '-n', '20']), { _: ['logs', 'svc'], follow: true, n: '20' });
  assert.deepEqual(parseArgs(['--only', 'a', '--dry-run']), { _: [], only: 'a', 'dry-run': true });
  assert.deepEqual(parseArgs(['-h', '-v']), { _: [], help: true, version: true });
});

test('parseArgs: 값이 필요한 옵션에 값이 없으면 예외', () => {
  assert.throws(() => parseArgs(['up', '--only']), /--only needs a value/);
  assert.throws(() => parseArgs(['-c']), /--config needs a value/);
});

// ---------------------------------------------------------------- 기본 명령

test('--version, 도움말, 알 수 없는 명령', async () => {
  const cwd = tempDir();
  const v = await run(['--version'], cwd);
  assert.equal(v.code, 0);
  assert.equal(v.stdout.trim(), version);

  for (const args of [[], ['help'], ['up', '--help']]) {
    const help = await run(args, cwd);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Usage/);
  }

  const bad = await run(['launch'], cwd);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Unknown command: launch/);

  const missing = await run(['up', '--config'], cwd);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /--config needs a value/);
});

test('설정 파일이 없거나 잘못되면 이유와 함께 exit 1', async () => {
  const empty = await run(['up'], tempDir());
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /Run `devfleet init` in the project root first/);

  const notFound = await run(['status', '-c', 'nope.yaml'], tempDir());
  assert.equal(notFound.code, 1);
  assert.match(notFound.stderr, /not found/);

  const broken = project({ services: { a: { cmd: 'true', depends_on: ['ghost'] } } });
  const result = await run(['up'], broken);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Invalid config/);
  assert.match(result.stderr, /ghost/);
});

// ---------------------------------------------------------------- init

test('init: 만들기, 덮어쓰기 거부, --force, --print', async () => {
  const root = tempDir('devfleet-cli-init-');
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('api/build.gradle', "plugins { id 'org.springframework.boot' version '3.5.0' }\n");
  write('api/gradlew', '');
  write('api/src/main/resources/application.yml', 'server:\n  port: 8081\n');

  const created = await run(['init'], root);
  assert.equal(created.code, 0, created.stderr);
  assert.match(created.stdout, /Created devfleet\.yaml/);
  assert.match(created.stdout, /Spring Boot apps \(1\): api/);
  const file = path.join(root, 'devfleet.yaml');
  assert.match(fs.readFileSync(file, 'utf8'), /port: 8081/);

  fs.writeFileSync(file, '# 직접 고친 내용\n');
  const refused = await run(['init'], root);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /--force/);
  assert.equal(fs.readFileSync(file, 'utf8'), '# 직접 고친 내용\n');

  const printed = await run(['init', '--print'], root);
  assert.equal(printed.code, 0);
  assert.match(printed.stdout, /services:/);
  assert.equal(fs.readFileSync(file, 'utf8'), '# 직접 고친 내용\n', '--print는 파일을 건드리지 않는다');

  const forced = await run(['init', '--force'], root);
  assert.equal(forced.code, 0);
  assert.match(fs.readFileSync(file, 'utf8'), /port: 8081/);
});

// ---------------------------------------------------------------- up / status / logs

test('up --dry-run은 실행하지 않고 단계별 계획을 보여준다', async () => {
  const root = project({
    services: {
      db: { cmd: 'echo db', health: 'none' },
      api: { cmd: 'echo api', health: 'none', depends_on: ['db'] },
    },
  });
  const plan = await run(['up', '--dry-run'], root);
  assert.equal(plan.code, 0, plan.stderr);
  assert.match(plan.stdout, /Wave 1 \(started together\)\n  db\n/);
  assert.match(plan.stdout, /Wave 2 \(started together\)\n  api ← db\n/);
  assert.ok(!fs.existsSync(path.join(root, '.devfleet')), 'dry-run은 로그 폴더도 만들지 않는다');

  const unknown = await run(['up', 'ghost', '--dry-run'], root);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /ghost/);
});

test('up --dry-run은 빌드 명령과 java -jar 실행을 보여주고, --no-build면 빌드를 뺀다', async () => {
  const root = project({
    services: {
      app: { dir: 'app', build: './gradlew bootJar', jar: 'build/libs/*.jar', java_opts: '-Xmx256m', port: 7071 },
    },
  });
  const plan = await run(['up', '--dry-run'], root);
  assert.equal(plan.code, 0, plan.stderr);
  assert.match(plan.stdout, /  app\n    build: \.\/gradlew bootJar  @ app\n    java -Xmx256m -jar build\/libs\/\*\.jar  @ app\n/);
  const noBuild = await run(['up', '--dry-run', '--no-build'], root);
  assert.doesNotMatch(noBuild.stdout, /build:/);
});

test('up → status → Ctrl+C: 모두 정리하고 exit 130, 이후 status·logs', async () => {
  const [pa, pb] = await Promise.all([freePort(), freePort()]);
  const root = project({
    services: {
      a: { cmd: fake(`--port=${pa}`), port: pa },
      b: { cmd: fake(`--port=${pb}`), port: pb, depends_on: ['a'] },
    },
  });
  const up = start(['up'], root);
  try {
    await up.waitFor(/Ctrl\+C stops everything/);
    assert.match(up.output(), /a +│ listening/);

    const status = await run(['status'], root);
    assert.equal(status.code, 0);
    assert.match(status.stdout, new RegExp(`a +${pa} +● healthy`));
    assert.match(status.stdout, new RegExp(`b +${pb} +● healthy`));

    up.child.kill('SIGINT');
    assert.equal(await up.exited, 130);
    assert.match(up.output(), /Shutting down… \(press Ctrl\+C again to force\)/);
  } finally {
    up.child.kill('SIGKILL');
  }
  assert.equal(await isPortOpen(pa), false);
  assert.equal(await isPortOpen(pb), false);

  const after = await run(['ps'], root);
  assert.match(after.stdout, new RegExp(`a +${pa} +○ stopped`));

  const logs = await run(['logs', 'a', '-n', '50'], root);
  assert.equal(logs.code, 0);
  assert.match(logs.stdout, new RegExp(`listening ${pa}`));

  const noName = await run(['logs'], root);
  assert.equal(noName.code, 1);
  assert.match(noName.stderr, /Name a service/);
  const unknown = await run(['logs', 'ghost'], root);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown service: ghost/);
});

test('up: 모든 서비스가 시작에 실패하면 exit 1', async () => {
  const port = await freePort();
  const root = project({ services: { broken: { cmd: fake(`--port=${port} --crash=100`), port } } });
  const result = await run(['up', '-q'], root);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /boom: fatal startup error/);
  assert.match(result.stdout, /No services are running; exiting/);
});

test('up: 준비된 서비스가 모두 죽으면 exit 1', async () => {
  const port = await freePort();
  const root = project({ services: { flaky: { cmd: fake(`--port=${port} --crash-after-ready=2500`), port } } });
  const result = await run(['up'], root);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /✖ flaky exited \(code 4\)/);
  assert.match(result.stdout, /Every service started by devfleet has exited/);
});

test('up: Ctrl+C 두 번이면 stop_timeout을 기다리지 않고 강제 종료한다', async () => {
  const port = await freePort();
  const root = project({
    services: { zombie: { cmd: fake(`--port=${port} --ignore=SIGINT,SIGTERM`), port, stop_timeout: 30 } },
  });
  const up = start(['up'], root);
  try {
    await up.waitFor(/Ctrl\+C stops everything/);
    up.child.kill('SIGINT');
    await up.waitFor(/ignored SIGINT/);
    const started = Date.now();
    up.child.kill('SIGINT');
    assert.equal(await up.exited, 130);
    assert.ok(Date.now() - started < 5000, '두 번째 Ctrl+C 뒤에는 바로 끝나야 한다');
  } finally {
    up.child.kill('SIGKILL');
  }
  assert.equal(await isPortOpen(port), false);
});

test('down: infra 설정이 없으면 exit 1', async () => {
  const root = project({ services: { a: { cmd: 'true', health: 'none' } } });
  const result = await run(['down'], root);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /No infra is configured/);
});

test('다른 터미널에서 restart → stop → status → down으로 실행 중인 up을 제어한다', async () => {
  const [pa, pb] = await Promise.all([freePort(), freePort()]);
  const root = project({
    services: {
      a: { cmd: fake(`--port=${pa}`), port: pa },
      b: { cmd: fake(`--port=${pb}`), port: pb, depends_on: ['a'] },
    },
    groups: { all: ['a', 'b'] },
  });
  const up = start(['up'], root);
  try {
    await up.waitFor(/Ctrl\+C stops everything/);

    const restart = await run(['restart', 'a'], root);
    assert.equal(restart.code, 0, restart.stderr);
    assert.match(restart.stdout, /a stopping…/);
    assert.match(restart.stdout, /✔ a ready in/);
    assert.match(restart.stdout, /a +✔ ready +\d+/);
    assert.match(up.output(), /restart requested from another terminal: a/);

    const stop = await run(['stop', 'b'], root);
    assert.equal(stop.code, 0, stop.stderr);
    assert.equal(await isPortOpen(pb), false);

    const status = await run(['status'], root);
    assert.match(status.stdout, /devfleet up is running \(PID \d+\)/);
    assert.match(status.stdout, new RegExp(`a +${pa} +● healthy +✔ ready`));
    assert.match(status.stdout, new RegExp(`b +${pb} +○ stopped +■ stopped`));

    const group = await run(['restart', 'all'], root);
    assert.equal(group.code, 0, group.stderr);
    assert.equal(await isPortOpen(pb), true);

    const unknown = await run(['restart', 'ghost'], root);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /Unknown service or group: ghost/);
    const noName = await run(['stop'], root);
    assert.equal(noName.code, 1);
    assert.match(noName.stderr, /Name a service or group/);

    const down = await run(['down'], root);
    assert.equal(down.code, 0, down.stderr);
    assert.match(down.stdout, /Stopped the running devfleet up/);
    assert.equal(await up.exited, 0);
    assert.match(up.output(), /Shutting down \(requested by devfleet down\)/);
  } finally {
    up.child.kill('SIGKILL');
  }
  assert.equal(await isPortOpen(pa), false);
  assert.equal(await isPortOpen(pb), false);

  const after = await run(['restart', 'a'], root);
  assert.equal(after.code, 1);
  assert.match(after.stderr, /No devfleet up is running for this project/);
});
