import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFleet } from '../src/runner.ts';
import { isPortOpen } from '../src/ports.ts';
import { fake, freePort, setup, tempDir } from './helpers.ts';

test('Ctrl+C(SIGINT)를 무시하면 stop_timeout 뒤 SIGTERM으로 종료한다', async () => {
  const port = await freePort();
  const { config, out, output } = setup({
    services: { stubborn: { cmd: fake(`--port=${port} --ignore=SIGINT`), port, stop_timeout: 1 } },
  });
  const fleet = startFleet(config, [], { out, color: false });
  assert.equal((await fleet.ready)[0]?.status, 'ready');
  const started = Date.now();
  await fleet.stop();
  const elapsed = Date.now() - started;
  assert.match(output(), /ignored SIGINT/);
  assert.ok(elapsed >= 900 && elapsed < 5000, `SIGTERM까지 약 1초 걸려야 한다 (실제 ${elapsed}ms)`);
  assert.equal(await isPortOpen(port), false);
});

test('SIGINT와 SIGTERM을 모두 무시하면 SIGKILL로 끝낸다', async () => {
  const port = await freePort();
  const { config, out, output } = setup({
    services: { zombie: { cmd: fake(`--port=${port} --ignore=SIGINT,SIGTERM`), port, stop_timeout: 1 } },
  });
  const fleet = startFleet(config, [], { out, color: false });
  await fleet.ready;
  const started = Date.now();
  await fleet.stop();
  const elapsed = Date.now() - started;
  assert.match(output(), /ignored SIGINT/);
  assert.match(output(), /ignored SIGTERM/);
  assert.ok(elapsed >= 5500 && elapsed < 12_000, `stop_timeout 1초 + SIGTERM 유예 5초 뒤 SIGKILL (실제 ${elapsed}ms)`);
  assert.equal(await isPortOpen(port), false);
});

test('강제 종료(force)는 기다리지 않고 바로 SIGKILL을 보낸다', async () => {
  const port = await freePort();
  const { config, out } = setup({
    services: { zombie: { cmd: fake(`--port=${port} --ignore=SIGINT,SIGTERM`), port, stop_timeout: 30 } },
  });
  const fleet = startFleet(config, [], { out, color: false });
  await fleet.ready;
  const started = Date.now();
  await fleet.stop({ force: true });
  assert.ok(Date.now() - started < 4000);
  assert.equal(await isPortOpen(port), false);
});

test('준비된 뒤 죽은 서비스는 crashed로 표시하고 숨겨져 있던 로그를 보여준다', async () => {
  const port = await freePort();
  const { config, out, output } = setup({
    services: { flaky: { cmd: fake(`--port=${port} --crash-after-ready=2500`), port } },
  });
  const fleet = startFleet(config, [], { out, color: false, quiet: true });
  assert.equal((await fleet.ready)[0]?.status, 'ready');
  await fleet.allExited;
  assert.equal(fleet.state.get('flaky')?.status, 'crashed');
  assert.match(output(), /✖ flaky 프로세스가 종료됐습니다 \(code 4\)/);
  assert.match(output(), /fatal: lost database connection/);
  await fleet.stop();
});

test('헬스체크 시간 초과: 실패로 보고 의존 서비스는 건너뛰되 프로세스는 계속 둔다', async () => {
  const [slow, dependent] = await Promise.all([freePort(), freePort()]);
  const { config, out, output } = setup({
    services: {
      slow: {
        cmd: fake(`--port=${slow} --status=503`),
        port: slow,
        health: { http: `http://127.0.0.1:${slow}/actuator/health`, timeout: 1 },
      },
      dependent: { cmd: fake(`--port=${dependent}`), port: dependent, depends_on: ['slow'] },
    },
  });
  const fleet = startFleet(config, [], { out, color: false });
  const rows = await fleet.ready;
  assert.deepEqual(
    rows.map((r) => [r.name, r.status]),
    [
      ['slow', 'failed'],
      ['dependent', 'skipped'],
    ],
  );
  assert.ok(rows[0]?.pid, '시간 초과된 프로세스는 계속 실행한다');
  assert.match(output(), /1초 안에 준비되지 않았습니다 \(http:\/\/127\.0\.0\.1:\d+\/actuator\/health\)/);
  await fleet.stop();
  assert.equal(await isPortOpen(slow), false);
});

test('환경변수 우선순위: 시스템 < env_file < env < 서비스 env_file < 서비스 env', async () => {
  const port = await freePort();
  const root = tempDir();
  fs.writeFileSync(path.join(root, '.env'), 'DF_A=file\nDF_B=file\n');
  fs.writeFileSync(path.join(root, 'svc.env'), 'DF_C=svcfile\nDF_D=svcfile\n');
  const { config, out, output } = setup(
    {
      env_file: '.env',
      env: { DF_B: 'cfg', DF_C: 'cfg' },
      services: {
        app: {
          cmd: fake(`--port=${port} --print-env=DF_A,DF_B,DF_C,DF_D,DF_E`),
          port,
          env_file: 'svc.env',
          env: { DF_D: 'svc' },
        },
      },
    },
    root,
  );
  process.env.DF_A = 'proc';
  process.env.DF_E = 'proc';
  try {
    const fleet = startFleet(config, [], { out, color: false });
    await fleet.ready;
    await fleet.stop();
  } finally {
    delete process.env.DF_A;
    delete process.env.DF_E;
  }
  const log = output();
  assert.match(log, /env DF_A=file/);
  assert.match(log, /env DF_B=cfg/);
  assert.match(log, /env DF_C=svcfile/);
  assert.match(log, /env DF_D=svc/);
  assert.match(log, /env DF_E=proc/);
});

test('폴더나 서비스 env_file이 없으면 실행하지 않고 이유를 알려준다', async () => {
  const [p1, p2] = await Promise.all([freePort(), freePort()]);
  const { config, out, output } = setup({
    services: {
      nodir: { cmd: fake(`--port=${p1}`), port: p1, dir: 'does-not-exist' },
      noenv: { cmd: fake(`--port=${p2}`), port: p2, env_file: 'missing.env' },
    },
  });
  const fleet = startFleet(config, [], { out, color: false });
  const rows = await fleet.ready;
  assert.deepEqual(
    rows.map((r) => r.status),
    ['failed', 'failed'],
  );
  assert.match(output(), /nodir 폴더가 없습니다/);
  assert.match(output(), /noenv env 파일을 찾을 수 없습니다/);
  await fleet.stop();
});

test('--only로 지정한 서비스 로그만 화면에 보이고 파일에는 모두 남는다', async () => {
  const [pa, pb] = await Promise.all([freePort(), freePort()]);
  const { config, out, output } = setup({
    services: { a: { cmd: fake(`--port=${pa}`), port: pa }, b: { cmd: fake(`--port=${pb}`), port: pb } },
  });
  const fleet = startFleet(config, [], { out, color: false, only: ['b'] });
  await fleet.ready;
  await fleet.stop();
  assert.doesNotMatch(output(), /^a +│ listening/m);
  assert.match(output(), /^b +│ listening/m);
  assert.match(fs.readFileSync(path.join(config.logDir, 'a.log'), 'utf8'), /listening/);
});
