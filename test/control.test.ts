import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startFleet } from '../src/runner.ts';
import { isPortOpen } from '../src/ports.ts';
import { controlPath, serveControl, sendControl } from '../src/control.ts';
import { fake, freePort, setup, sleep, tempDir } from './helpers.ts';

const settled = (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);

test('restart: 서비스만 다시 띄우고, 의존 서비스는 그대로 둔다', async () => {
  const [pa, pb] = await Promise.all([freePort(), freePort()]);
  const { config, out, output } = setup({
    services: {
      a: { cmd: fake(`--port=${pa}`), port: pa },
      b: { cmd: fake(`--port=${pb}`), port: pb, depends_on: ['a'] },
    },
  });
  const fleet = startFleet(config, [], { out, color: false });
  try {
    await fleet.ready;
    const before = new Map(fleet.summarize().map((r) => [r.name, r.pid]));

    const mark = output().length;
    assert.deepEqual(await fleet.restart(['a']), { ok: true });
    const log = output().slice(mark);
    assert.ok(log.indexOf('a stopping') < log.indexOf('a starting'), '멈춘 뒤에 다시 띄워야 한다');
    assert.match(log, /✔ a ready in/);
    assert.doesNotMatch(log, /exited \(/, '재시작으로 끝난 프로세스는 crashed가 아니다');

    const after = new Map(fleet.summarize().map((r) => [r.name, r]));
    assert.equal(after.get('a')?.status, 'ready');
    assert.notEqual(after.get('a')?.pid, before.get('a'));
    assert.equal(after.get('b')?.pid, before.get('b'), 'b는 재시작하지 않는다');
    assert.equal(await isPortOpen(pa), true);
  } finally {
    await fleet.stop();
  }
  assert.equal(await isPortOpen(pa), false);
  assert.equal(await isPortOpen(pb), false);
});

test('restart: 여러 서비스는 의존 서비스부터 멈추고 의존성 순서대로 띄운다', async () => {
  const [pa, pb] = await Promise.all([freePort(), freePort()]);
  const { config, out, output } = setup({
    services: {
      a: { cmd: fake(`--port=${pa}`), port: pa },
      b: { cmd: fake(`--port=${pb}`), port: pb, depends_on: ['a'] },
    },
  });
  const fleet = startFleet(config, [], { out, color: false });
  try {
    await fleet.ready;
    const mark = output().length;
    assert.deepEqual(await fleet.restart(['a', 'b']), { ok: true });
    const log = output().slice(mark);
    assert.ok(log.indexOf('b stopping') < log.indexOf('a stopping'));
    assert.ok(log.indexOf('a ready in') < log.indexOf('b starting'));
  } finally {
    await fleet.stop();
  }
});

test('stop은 서비스를 멈추고, 멈춘 서비스가 있으면 fleet을 끝내지 않으며, restart로 다시 띄운다', async () => {
  const port = await freePort();
  const { config, out } = setup({ services: { a: { cmd: fake(`--port=${port}`), port } } });
  const fleet = startFleet(config, [], { out, color: false });
  try {
    await fleet.ready;
    assert.deepEqual(await fleet.stopServices(['a']), { ok: true });
    assert.equal(fleet.summarize()[0]?.status, 'stopped');
    assert.equal(await isPortOpen(port), false);
    assert.equal(await settled(fleet.allExited, 300), false, '요청으로 멈춘 서비스는 다시 띄울 수 있어야 한다');

    assert.deepEqual(await fleet.restart(['a']), { ok: true });
    assert.equal(fleet.summarize()[0]?.status, 'ready');
  } finally {
    await fleet.stop();
  }
});

test('crashed 서비스를 restart로 되살린다', async () => {
  const port = await freePort();
  const { config, out } = setup({
    services: { flaky: { cmd: fake(`--port=${port} --crash-after-ready=2500`), port } },
  });
  const fleet = startFleet(config, [], { out, color: false, quiet: true });
  try {
    await fleet.ready;
    while (fleet.summarize()[0]?.status !== 'crashed') await sleep(50);
    assert.deepEqual(await fleet.restart(['flaky']), { ok: true });
    assert.equal(fleet.summarize()[0]?.status, 'ready');
  } finally {
    await fleet.stop();
  }
});

test('restart가 거절되는 경우: 모르는 서비스, 이번 실행 밖의 서비스, 시작 중, 의존성이 준비되지 않음', async () => {
  const [pa, pb] = await Promise.all([freePort(), freePort()]);
  const { config, out } = setup({
    services: {
      a: { cmd: fake(`--port=${pa} --delay=300`), port: pa },
      b: { cmd: fake(`--port=${pb}`), port: pb, depends_on: ['a'] },
      other: { cmd: 'true', health: 'none' },
    },
  });
  const fleet = startFleet(config, ['b'], { out, color: false });
  try {
    const early = await fleet.restart(['a']);
    assert.equal(early.ok, false);
    assert.match(early.error ?? '', /still starting up/);
    await fleet.ready;

    assert.match((await fleet.restart(['ghost'])).error ?? '', /Unknown service: ghost/);
    assert.match((await fleet.restart(['other'])).error ?? '', /not started by this devfleet up: other/);

    await fleet.stopServices(['a']);
    const result = await fleet.restart(['b']);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /not ready: b/);
    assert.equal(fleet.summarize().find((r) => r.name === 'b')?.status, 'skipped');
  } finally {
    await fleet.stop();
  }
});

test('제어 소켓: 요청과 진행 로그, 결과를 주고받고 닫으면 소켓 파일을 지운다', async () => {
  const root = tempDir();
  const socketPath = controlPath({ root, file: `${root}/devfleet.yaml` });
  assert.equal(await sendControl(socketPath, { cmd: 'status' }), null, '실행 중인 up이 없으면 null');

  const server = await serveControl(socketPath, async (request, reply) => {
    reply.log(`got ${request.cmd}`);
    await reply.done({ ok: request.cmd === 'restart', error: request.cmd === 'restart' ? undefined : 'nope' });
  });
  assert.ok(server);
  try {
    assert.equal(await serveControl(socketPath, () => {}), null, '같은 설정의 두 번째 up은 소켓을 갖지 않는다');

    const lines: string[] = [];
    const ok = await sendControl(socketPath, { cmd: 'restart', names: ['a'] }, (line) => lines.push(line));
    assert.deepEqual(lines, ['got restart']);
    assert.equal(ok?.ok, true);
    const refused = await sendControl(socketPath, { cmd: 'stop', names: ['a'] });
    assert.deepEqual(refused, { ok: false, error: 'nope' });
  } finally {
    await server.close();
  }
  if (process.platform !== 'win32') assert.equal(fs.existsSync(socketPath), false);
});

test('제어 소켓: 죽은 프로세스가 남긴 소켓 파일은 지우고 다시 쓴다', { skip: process.platform === 'win32' }, async () => {
  const root = tempDir();
  const socketPath = controlPath({ root, file: `${root}/devfleet.yaml` });
  fs.writeFileSync(socketPath, '');
  assert.equal(await sendControl(socketPath, { cmd: 'status' }), null);
  const server = await serveControl(socketPath, (_request, reply) => reply.done({ ok: true, pid: 42 }));
  assert.ok(server);
  try {
    assert.deepEqual(await sendControl(socketPath, { cmd: 'status' }), { ok: true, pid: 42 });
  } finally {
    await server.close();
  }
});
