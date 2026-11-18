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
  assert.throws(() => parseArgs(['up', '--only']), /--only에 값이 필요합니다/);
  assert.throws(() => parseArgs(['-c']), /--config에 값이 필요합니다/);
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
    assert.match(help.stdout, /사용법/);
  }

  const bad = await run(['launch'], cwd);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /알 수 없는 명령: launch/);

  const missing = await run(['up', '--config'], cwd);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /--config에 값이 필요합니다/);
});

test('설정 파일이 없거나 잘못되면 이유와 함께 exit 1', async () => {
  const empty = await run(['up'], tempDir());
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /devfleet init`을 먼저 실행하세요/);

  const notFound = await run(['status', '-c', 'nope.yaml'], tempDir());
  assert.equal(notFound.code, 1);
  assert.match(notFound.stderr, /찾지 못했습니다/);

  const broken = project({ services: { a: { cmd: 'true', depends_on: ['ghost'] } } });
  const result = await run(['up'], broken);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /설정 오류/);
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
  assert.match(created.stdout, /devfleet\.yaml을 만들었습니다/);
  assert.match(created.stdout, /Spring Boot 앱 1개: api/);
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
  assert.match(plan.stdout, /1단계 \(동시 시작\)\n  db\n/);
  assert.match(plan.stdout, /2단계 \(동시 시작\)\n  api ← db\n/);
  assert.ok(!fs.existsSync(path.join(root, '.devfleet')), 'dry-run은 로그 폴더도 만들지 않는다');

  const unknown = await run(['up', 'ghost', '--dry-run'], root);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /ghost/);
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
    await up.waitFor(/Ctrl\+C로 모두 종료/);
    assert.match(up.output(), /a +│ listening/);

    const status = await run(['status'], root);
    assert.equal(status.code, 0);
    assert.match(status.stdout, new RegExp(`a +${pa} +● 정상`));
    assert.match(status.stdout, new RegExp(`b +${pb} +● 정상`));

    up.child.kill('SIGINT');
    assert.equal(await up.exited, 130);
    assert.match(up.output(), /종료합니다… \(한 번 더 Ctrl\+C: 강제 종료\)/);
  } finally {
    up.child.kill('SIGKILL');
  }
  assert.equal(await isPortOpen(pa), false);
  assert.equal(await isPortOpen(pb), false);

  const after = await run(['ps'], root);
  assert.match(after.stdout, new RegExp(`a +${pa} +○ 중지`));

  const logs = await run(['logs', 'a', '-n', '50'], root);
  assert.equal(logs.code, 0);
  assert.match(logs.stdout, new RegExp(`listening ${pa}`));

  const noName = await run(['logs'], root);
  assert.equal(noName.code, 1);
  assert.match(noName.stderr, /서비스 이름을 지정하세요/);
  const unknown = await run(['logs', 'ghost'], root);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /알 수 없는 서비스: ghost/);
});

test('up: 모든 서비스가 시작에 실패하면 exit 1', async () => {
  const port = await freePort();
  const root = project({ services: { broken: { cmd: fake(`--port=${port} --crash=100`), port } } });
  const result = await run(['up', '-q'], root);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /boom: fatal startup error/);
  assert.match(result.stdout, /실행 중인 서비스가 없어 종료합니다/);
});

test('up: 준비된 서비스가 모두 죽으면 exit 1', async () => {
  const port = await freePort();
  const root = project({ services: { flaky: { cmd: fake(`--port=${port} --crash-after-ready=2500`), port } } });
  const result = await run(['up'], root);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /flaky 프로세스가 종료됐습니다 \(code 4\)/);
  assert.match(result.stdout, /직접 띄운 서비스가 모두 종료됐습니다/);
});

test('up: Ctrl+C 두 번이면 stop_timeout을 기다리지 않고 강제 종료한다', async () => {
  const port = await freePort();
  const root = project({
    services: { zombie: { cmd: fake(`--port=${port} --ignore=SIGINT,SIGTERM`), port, stop_timeout: 30 } },
  });
  const up = start(['up'], root);
  try {
    await up.waitFor(/Ctrl\+C로 모두 종료/);
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
  assert.match(result.stderr, /infra가 없습니다/);
});
