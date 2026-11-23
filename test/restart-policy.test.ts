import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { normalizeConfig } from '../src/config.ts';
import { startFleet, type Fleet } from '../src/runner.ts';
import { isPortOpen } from '../src/ports.ts';
import { fake, freePort, setup, sleep } from './helpers.ts';

const settled = (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);

async function waitStatus(fleet: Fleet, name: string, status: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (fleet.summarize().find((r) => r.name === name)?.status !== status) {
    if (Date.now() > deadline) throw new Error(`${name}이(가) ${status} 상태가 되기를 기다리다 시간 초과`);
    await sleep(50);
  }
}

test('restart 설정: 기본값, 최상위 기본값, 서비스별 덮어쓰기, 잘못된 값', () => {
  const plain = normalizeConfig({ services: { a: { cmd: 'x' } } }, '/p');
  assert.equal(plain.services.a?.restart, 'no');
  assert.equal(plain.services.a?.maxRestarts, 3);

  const config = normalizeConfig(
    {
      restart: 'on-failure',
      max_restarts: 5,
      services: { a: { cmd: 'x' }, b: { cmd: 'x', restart: false, max_restarts: 0 } },
    },
    '/p',
  );
  assert.deepEqual(config.errors, []);
  assert.deepEqual([config.services.a?.restart, config.services.a?.maxRestarts], ['on-failure', 5]);
  assert.deepEqual([config.services.b?.restart, config.services.b?.maxRestarts], ['no', 0]);

  const bad = normalizeConfig({ max_restarts: -1, services: { a: { cmd: 'x', restart: 'always', max_restarts: 1.5 } } }, '/p');
  assert.deepEqual(bad.errors, [
    'max_restarts must be a whole number of 0 or more.',
    'a: restart must be "no" or "on-failure".',
    'a: max_restarts must be a whole number of 0 or more.',
  ]);
});

test('on-failure: 준비된 뒤 죽으면 잠시 기다렸다가 다시 띄운다', async () => {
  const port = await freePort();
  const { config, out, output, root } = setup({ services: { flaky: { cmd: 'x', port, restart: 'on-failure' } } });
  const counter = path.join(root, 'runs');
  config.services.flaky!.cmd = fake(`--port=${port} --crash-after-ready=1500 --crash-times=1 --counter=${counter}`);
  const fleet = startFleet(config, [], { out, color: false, restartDelayMs: 100 });
  try {
    await fleet.ready;
    await waitStatus(fleet, 'flaky', 'restarting');
    await waitStatus(fleet, 'flaky', 'ready');
    assert.match(output(), /✖ flaky exited \(code 4\)/);
    assert.match(output(), /! flaky restarting in 0\.1s \(attempt 1\/3\)/);
    assert.equal(fleet.summarize()[0]?.restarts, 1);
    assert.equal(await isPortOpen(port), true);
    assert.equal(await settled(fleet.allExited, 300), false);
  } finally {
    await fleet.stop();
  }
});

test('on-failure: max_restarts번 연속으로 실패하면 포기하고, 남은 서비스가 없으면 fleet이 끝난다', async () => {
  const port = await freePort();
  const { config, out, output } = setup({
    services: {
      flaky: { cmd: fake(`--port=${port} --crash-after-ready=1500`), port, restart: 'on-failure', max_restarts: 2 },
    },
  });
  const fleet = startFleet(config, [], { out, color: false, quiet: true, restartDelayMs: 100 });
  try {
    await fleet.ready;
    assert.equal(await settled(fleet.allExited, 20_000), true, '포기한 뒤에는 fleet이 끝나야 한다');
    const log = output();
    assert.match(log, /restarting in 0\.1s \(attempt 1\/2\)/);
    assert.match(log, /restarting in 0\.2s \(attempt 2\/2\)/, '두 번째 시도는 두 배로 기다린다');
    assert.match(log, /not restarting: gave up after 2 automatic restart\(s\) \(max_restarts: 2\)/);
    assert.doesNotMatch(log, /attempt 3/);
    const row = fleet.summarize()[0];
    assert.equal(row?.status, 'crashed');
    assert.equal(row?.restarts, 2);
  } finally {
    await fleet.stop();
  }
});

test('restart 설정이 없으면 죽은 서비스를 다시 띄우지 않는다', async () => {
  const port = await freePort();
  const { config, out, output } = setup({
    services: { flaky: { cmd: fake(`--port=${port} --crash-after-ready=1500`), port } },
  });
  const fleet = startFleet(config, [], { out, color: false, quiet: true, restartDelayMs: 100 });
  try {
    await fleet.ready;
    assert.equal(await settled(fleet.allExited, 10_000), true);
    assert.doesNotMatch(output(), /restarting in/);
    assert.equal(fleet.summarize()[0]?.restarts, 0);
  } finally {
    await fleet.stop();
  }
});

test('자동 재시작을 기다리는 서비스는 stop 요청이 취소하고 멈춘다', async () => {
  const port = await freePort();
  const { config, out, output } = setup({
    services: { flaky: { cmd: fake(`--port=${port} --crash-after-ready=1500`), port, restart: 'on-failure' } },
  });
  const fleet = startFleet(config, [], { out, color: false, restartDelayMs: 10_000 });
  try {
    await fleet.ready;
    await waitStatus(fleet, 'flaky', 'restarting');
    const started = Date.now();
    assert.deepEqual(await fleet.stopServices(['flaky']), { ok: true });
    assert.ok(Date.now() - started < 3000, '재시작 대기를 끝까지 기다리지 않아야 한다');
    assert.match(output(), /flaky cancelling the automatic restart/);
    assert.equal(fleet.summarize()[0]?.status, 'stopped');
    assert.equal(await settled(fleet.allExited, 300), false, '요청으로 멈춘 서비스는 다시 띄울 수 있어야 한다');
    assert.equal((output().match(/flaky starting:/g) ?? []).length, 1, '다시 띄우지 않아야 한다');
  } finally {
    await fleet.stop();
  }
});

test('자동 재시작을 기다리는 중에 전체 종료하면 바로 끝나고 다시 띄우지 않는다', async () => {
  const port = await freePort();
  const { config, out, output } = setup({
    services: { flaky: { cmd: fake(`--port=${port} --crash-after-ready=1500`), port, restart: 'on-failure' } },
  });
  const fleet = startFleet(config, [], { out, color: false, restartDelayMs: 10_000 });
  await fleet.ready;
  await waitStatus(fleet, 'flaky', 'restarting');
  const started = Date.now();
  await fleet.stop();
  assert.ok(Date.now() - started < 3000);
  assert.equal((output().match(/flaky starting:/g) ?? []).length, 1);
  assert.equal(await isPortOpen(port), false);
});
