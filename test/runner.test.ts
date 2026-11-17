import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { normalizeConfig } from '../src/config.ts';
import { startFleet } from '../src/runner.ts';
import { isPortOpen } from '../src/ports.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-service.ts', import.meta.url));
const node = JSON.stringify(process.execPath);
const fake = (flags: string): string => `${node} ${JSON.stringify(FAKE)} ${flags}`;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function setup(services: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devfleet-'));
  const config = normalizeConfig({ services, ...extra }, root);
  assert.deepEqual(config.errors, []);
  const out = new PassThrough();
  let text = '';
  out.on('data', (chunk) => (text += chunk));
  return { config, out, output: () => text, root };
}

test('의존성 순서대로 띄우고, 준비를 기다리고, 역순으로 종료한다', async () => {
  const [pa, pb, pc] = await Promise.all([freePort(), freePort(), freePort()]);
  const { config, out, output } = setup(
    {
      a: { cmd: fake(`--port=${pa} --delay=400`), port: pa },
      b: { cmd: fake(`--port=${pb}`), port: pb, depends_on: ['a'], health: `http://127.0.0.1:${pb}/health` },
      c: { cmd: fake(`--port=${pc}`), port: pc, depends_on: ['b'], env_file: '.env.c' },
    },
    { env: { FAKE_VAR: 'global' } },
  );
  fs.writeFileSync(path.join(config.root, '.env.c'), 'FAKE_VAR=from-env-file\n');

  const fleet = startFleet(config, [], { out, color: false });
  const rows = await fleet.ready;
  assert.deepEqual(
    rows.map((r) => [r.name, r.status]),
    [
      ['a', 'ready'],
      ['b', 'ready'],
      ['c', 'ready'],
    ],
  );
  const log = output();
  assert.ok(log.indexOf('a 준비 완료') < log.indexOf('b 시작'), 'b는 a가 준비된 뒤 시작해야 한다');
  assert.ok(log.indexOf('b 준비 완료') < log.indexOf('c 시작'));
  assert.match(log, /a +│ starting on \d+ FAKE_VAR=global/);
  assert.match(log, /c +│ starting on \d+ FAKE_VAR=from-env-file/);

  await fleet.stop();
  const stopLog = output().slice(log.length);
  assert.ok(stopLog.indexOf('c 종료 중') < stopLog.indexOf('a 종료 중'), '역순으로 종료해야 한다');
  for (const port of [pa, pb, pc]) assert.equal(await isPortOpen(port), false);
  assert.match(fs.readFileSync(path.join(config.logDir, 'a.log'), 'utf8'), /listening/);
});

test('시작 중 죽은 서비스는 실패로, 그 의존 서비스는 건너뜀으로 표시하고 마지막 로그를 보여준다', async () => {
  const [pa, pb] = await Promise.all([freePort(), freePort()]);
  const { config, out, output } = setup({
    a: { cmd: fake(`--port=${pa} --crash=100`), port: pa },
    b: { cmd: fake(`--port=${pb}`), port: pb, depends_on: ['a'] },
  });
  const fleet = startFleet(config, [], { out, color: false, quiet: true });
  const rows = await fleet.ready;
  assert.deepEqual(
    rows.map((r) => r.status),
    ['failed', 'skipped'],
  );
  assert.match(output(), /준비되기 전에 종료됐습니다 \(code 3\)/);
  assert.match(output(), /boom: fatal startup error/, 'quiet 모드여도 실패한 서비스의 로그는 보여야 한다');
  assert.doesNotMatch(output(), /b 시작/);
  await fleet.stop();
});

test('Gradle 데몬처럼 프로세스 그룹 밖에 남은 앱도 포트 기준으로 정리한다', async () => {
  const port = await freePort();
  const { config, out, output } = setup({ app: { cmd: fake(`--port=${port} --orphan`), port, stop_timeout: 2 } });
  const fleet = startFleet(config, [], { out, color: false });
  assert.equal((await fleet.ready)[0].status, 'ready');
  await fleet.stop();
  assert.match(output(), /남은 PID \d+/);
  assert.equal(await isPortOpen(port), false);
});

test('이미 떠 있는 정상 서비스는 재사용하고, 포트만 점유한 프로세스는 막는다', async () => {
  const [okPort, badPort] = await Promise.all([freePort(), freePort()]);
  const okServer = http.createServer((_, res) => res.end('ok')).listen(okPort);
  const badServer = http.createServer((_, res) => {
    res.statusCode = 503;
    res.end();
  }).listen(badPort);
  try {
    const { config, out, output } = setup({
      ok: { cmd: 'exit 1', port: okPort, health: `http://127.0.0.1:${okPort}/` },
      bad: { cmd: 'exit 1', port: badPort, health: `http://127.0.0.1:${badPort}/` },
    });
    const fleet = startFleet(config, [], { out, color: false });
    const rows = await fleet.ready;
    assert.deepEqual(
      rows.map((r) => r.status),
      ['external', 'failed'],
    );
    assert.match(output(), new RegExp(`포트 ${badPort}를 다른 프로세스가 쓰고 있습니다 \\(PID \\d+`));
    await fleet.stop();
    assert.equal(await isPortOpen(okPort), true, '직접 띄우지 않은 프로세스는 종료하면 안 된다');
  } finally {
    okServer.close();
    badServer.close();
  }
});

test('--no-deps: 제외된 의존 서비스가 실행 중이 아니면 건너뛴다', async () => {
  const [pa, pb] = await Promise.all([freePort(), freePort()]);
  const { config, out } = setup({
    a: { cmd: fake(`--port=${pa}`), port: pa },
    b: { cmd: fake(`--port=${pb}`), port: pb, depends_on: ['a'] },
  });
  const fleet = startFleet(config, ['b'], { out, color: false, deps: false, externalTimeoutMs: 500 });
  assert.deepEqual(fleet.plan.external, ['a']);
  const rows = await fleet.ready;
  assert.deepEqual(
    rows.map((r) => [r.name, r.status]),
    [['b', 'skipped']],
  );
  await fleet.stop();
});
