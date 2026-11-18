import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseEnv } from '../src/config.ts';
import { resolveTargets, waves } from '../src/graph.ts';

const raw = {
  services: {
    eureka: { cmd: 'x', port: 8761 },
    account: { cmd: 'x', port: 7071, depends_on: ['eureka'], health: 'http://127.0.0.1:7071/actuator/health' },
    menus: { cmd: 'x', port: 7072, depends_on: ['eureka'] },
    gateway: { cmd: 'x', port: 7070, depends_on: ['account', 'menus'] },
    tool: { cmd: 'x' },
  },
  groups: { core: ['account'] },
};

test('설정을 정규화하고 헬스체크 기본값을 채운다', () => {
  const config = normalizeConfig(raw, '/repo');
  assert.deepEqual(config.errors, []);
  assert.equal(config.services.account.dir, '/repo');
  assert.deepEqual(config.services.account.health.type, 'http');
  assert.deepEqual(config.services.eureka.health, { type: 'tcp', port: 8761, timeout: 180, interval: 1 });
  assert.equal(config.services.tool.health.type, 'none');
});

test('없는 의존성, 순환, 잘못된 그룹을 잡아낸다', () => {
  const bad = normalizeConfig(
    {
      services: { a: { cmd: 'x', depends_on: ['b'] }, b: { cmd: 'x', depends_on: ['a'] }, c: { depends_on: ['zzz'] } },
      groups: { g: ['nope'] },
    },
    '/r',
  );
  assert.ok(bad.errors.some((e) => e.includes("'zzz'")));
  assert.ok(bad.errors.some((e) => e.includes('cmd is required')));
  assert.ok(bad.errors.some((e) => e.includes("'nope'")));
  const cyclic = normalizeConfig({ services: { a: { cmd: 'x', depends_on: ['b'] }, b: { cmd: 'x', depends_on: ['a'] } } }, '/r');
  assert.ok(cyclic.errors.some((e) => e.includes('Dependency cycle')));
});

test('대상 서비스에 의존성을 포함하고 단계별로 묶는다', () => {
  const config = normalizeConfig(raw, '/repo');
  assert.deepEqual(resolveTargets(config, ['gateway']), ['eureka', 'account', 'menus', 'gateway']);
  assert.deepEqual(resolveTargets(config, ['core']), ['eureka', 'account']);
  assert.deepEqual(resolveTargets(config, ['gateway'], { withDeps: false }), ['gateway']);
  assert.throws(() => resolveTargets(config, ['nope']), /nope/);
  assert.deepEqual(waves(config.services, resolveTargets(config, [])), [
    ['eureka', 'tool'],
    ['account', 'menus'],
    ['gateway'],
  ]);
});

test('.env 형식을 해석한다', () => {
  const env = parseEnv(`# 주석\nA=1\nexport B="two words"\nC='raw $x'\nD=value # 주석\n\nbroken line`);
  assert.deepEqual(env, { A: '1', B: 'two words', C: 'raw $x', D: 'value' });
});
