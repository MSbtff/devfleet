import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig } from '../src/config.ts';
import { findJar, startFleet } from '../src/runner.ts';
import { isPortOpen } from '../src/ports.ts';
import { FAKE, freePort, setup, tempDir } from './helpers.ts';

const FAKE_BUILD = fileURLToPath(new URL('./fixtures/fake-build.ts', import.meta.url));
const node = JSON.stringify(process.execPath);
const skip = process.platform === 'win32'; // 가짜 java가 셸 스크립트라서

/** 가짜 빌드 명령. jar는 서비스 폴더의 build/libs/<name>-1.0.jar에 만들어진다. */
const build = (name: string, root: string, extra = '') =>
  `${node} ${JSON.stringify(FAKE_BUILD)} --name=${name} --out=build/libs/${name}-1.0.jar --log=${JSON.stringify(
    path.join(root, 'builds.log'),
  )} ${extra}`;

/** JAVA_HOME/bin/java 자리에 놓는 가짜 java: 받은 인자를 찍고 가짜 서비스를 실행한다. */
function fakeJavaHome(): string {
  const home = tempDir('devfleet-java-');
  fs.mkdirSync(path.join(home, 'bin'));
  const java = path.join(home, 'bin', 'java');
  fs.writeFileSync(java, `#!/bin/sh\necho "java $*"\nexec ${node} ${JSON.stringify(FAKE)} "$@"\n`);
  fs.chmodSync(java, 0o755);
  return home;
}

const buildLog = (root: string) =>
  fs.existsSync(path.join(root, 'builds.log')) ? fs.readFileSync(path.join(root, 'builds.log'), 'utf8').trim().split('\n') : [];

test('build·jar 설정: 문자열과 { cmd, dir }, cmd와 jar 중 하나만, 파일 이름에만 *', () => {
  const config = normalizeConfig(
    {
      build_concurrency: 2,
      services: {
        a: { dir: 'apps/a', build: './gradlew bootJar', jar: 'build/libs/*.jar', java_opts: '-Xmx256m' },
        b: { dir: 'apps/b', build: { cmd: './gradlew :apps:b:bootJar', dir: '.' }, jar: 'build/libs/*.jar' },
        c: { cmd: './run.sh' },
      },
    },
    '/p',
  );
  assert.deepEqual(config.errors, []);
  assert.equal(config.buildConcurrency, 2);
  assert.deepEqual(config.services.a?.build, { cmd: './gradlew bootJar', dir: '/p/apps/a' });
  assert.equal(config.services.a?.javaOpts, '-Xmx256m');
  assert.deepEqual(config.services.b?.build, { cmd: './gradlew :apps:b:bootJar', dir: '/p' });
  assert.equal(config.services.c?.build, null);
  assert.equal(normalizeConfig({ services: { a: { cmd: 'x' } } }, '/p').buildConcurrency, 1);

  const bad = normalizeConfig(
    {
      services: {
        both: { cmd: 'x', jar: 'a.jar' },
        neither: { build: 'make' },
        glob: { jar: 'build/*/app.jar' },
        weird: { cmd: 'x', build: { dir: '.' } },
      },
    },
    '/p',
  );
  assert.deepEqual(bad.errors, [
    'both: use either cmd or jar, not both.',
    'neither: cmd is required (or jar, to run a jar with java -jar).',
    'glob: jar may use * only in the file name, e.g. build/libs/*.jar.',
    'weird: build must be a shell command or { cmd, dir }.',
  ]);
});

test('findJar: 가장 최근 jar를 고르고 plain·sources·javadoc jar는 건너뛴다', () => {
  const dir = tempDir();
  const libs = path.join(dir, 'build/libs');
  fs.mkdirSync(libs, { recursive: true });
  const touch = (name: string, ageSeconds: number) => {
    const file = path.join(libs, name);
    fs.writeFileSync(file, name);
    const time = new Date(Date.now() - ageSeconds * 1000);
    fs.utimesSync(file, time, time);
  };
  touch('app-0.9.jar', 60);
  touch('app-1.0.jar', 10);
  touch('app-1.0-plain.jar', 0);
  touch('app-1.0-sources.jar', 0);
  touch('notes.txt', 0);
  assert.equal(findJar(dir, 'build/libs/*.jar'), path.join(libs, 'app-1.0.jar'));
  assert.equal(findJar(dir, 'build/libs/app-0.?.jar'), path.join(libs, 'app-0.9.jar'));
  assert.equal(findJar(dir, 'target/*.jar'), null);
});

test('빌드를 하나씩 먼저 돌리고, 결과 jar의 복사본을 java -jar로 실행한다', { skip }, async () => {
  const [pa, pb] = await Promise.all([freePort(), freePort()]);
  const root = tempDir();
  const javaHome = fakeJavaHome();
  const { config, out, output } = setup(
    {
      env: { JAVA_HOME: javaHome },
      services: {
        a: { dir: 'a', build: build('a', root, '--delay=300'), jar: 'build/libs/*.jar', java_opts: `--port=${pa}`, port: pa },
        b: { dir: 'b', build: build('b', root, '--delay=300'), jar: 'build/libs/*.jar', java_opts: `--port=${pb}`, port: pb },
      },
    },
    root,
  );
  fs.mkdirSync(path.join(root, 'a'));
  fs.mkdirSync(path.join(root, 'b'));
  const fleet = startFleet(config, [], { out, color: false });
  try {
    const rows = await fleet.ready;
    assert.deepEqual(rows.map((r) => r.status), ['ready', 'ready']);
    assert.deepEqual(buildLog(root), ['start a', 'end a', 'start b', 'end b'], 'build_concurrency 1: 한 번에 하나씩');
    const log = output();
    assert.match(log, /a +│ compiling a/);
    assert.match(log, /✔ a built in/);
    assert.match(log, /a running a\/build\/libs\/a-1\.0\.jar as \.devfleet\/jars\/a\.jar/);
    const runJar = path.join(root, '.devfleet', 'jars', 'a.jar');
    assert.match(log, new RegExp(`a +│ java --port=${pa} -jar ${runJar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal(fs.readFileSync(runJar, 'utf8'), 'a 1');
  } finally {
    await fleet.stop();
  }
  assert.equal(await isPortOpen(pa), false);
});

test('빌드가 실패하면 서비스는 failed, 의존 서비스는 건너뛰고 아무것도 띄우지 않는다', { skip }, async () => {
  const port = await freePort();
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'broken'), '');
  const { config, out, output } = setup(
    {
      env: { JAVA_HOME: fakeJavaHome() },
      services: {
        a: { build: build('a', root, `--fail-if=${path.join(root, 'broken')}`), jar: 'build/libs/*.jar', port },
        b: { cmd: 'true', health: 'none', depends_on: ['a'] },
      },
    },
    root,
  );
  const fleet = startFleet(config, [], { out, color: false, quiet: true });
  try {
    const rows = await fleet.ready;
    assert.deepEqual(rows.map((r) => [r.name, r.status]), [
      ['a', 'failed'],
      ['b', 'skipped'],
    ]);
    assert.match(output(), /✖ a build failed \(code 1\)/);
    assert.match(output(), /error: compilation failed for a/, '숨겨진 빌드 로그 끝부분을 보여준다');
    assert.doesNotMatch(output(), /starting:/);
  } finally {
    await fleet.stop();
  }
});

test('restart는 멈추기 전에 다시 빌드하고, 빌드가 실패하면 실행 중인 프로세스를 그대로 둔다', { skip }, async () => {
  const port = await freePort();
  const root = tempDir();
  const broken = path.join(root, 'broken');
  const { config, out, output } = setup(
    {
      env: { JAVA_HOME: fakeJavaHome() },
      services: { a: { build: build('a', root, `--fail-if=${broken}`), jar: 'build/libs/*.jar', java_opts: `--port=${port}`, port } },
    },
    root,
  );
  const runJar = path.join(root, '.devfleet', 'jars', 'a.jar');
  const fleet = startFleet(config, [], { out, color: false });
  try {
    await fleet.ready;
    const firstPid = fleet.summarize()[0]?.pid;

    let mark = output().length;
    assert.deepEqual(await fleet.restart(['a']), { ok: true });
    let log = output().slice(mark);
    assert.ok(log.indexOf('a building') < log.indexOf('a stopping'), '빌드가 끝난 뒤에 멈춘다');
    assert.equal(fs.readFileSync(runJar, 'utf8'), 'a 2', '새로 빌드한 jar로 실행한다');
    const secondPid = fleet.summarize()[0]?.pid;
    assert.notEqual(secondPid, firstPid);

    fs.writeFileSync(broken, '');
    mark = output().length;
    const failed = await fleet.restart(['a']);
    assert.deepEqual(failed, { ok: false, error: 'build failed: a' });
    log = output().slice(mark);
    assert.match(log, /not restarting: the build failed, so the running process is kept/);
    assert.doesNotMatch(log, /a stopping/);
    assert.equal(fleet.summarize()[0]?.pid, secondPid);
    assert.equal(fleet.summarize()[0]?.status, 'ready');
    assert.equal(await isPortOpen(port), true);

    const before = buildLog(root).length;
    assert.deepEqual(await fleet.restart(['a'], { build: false }), { ok: true });
    assert.equal(buildLog(root).length, before, '--no-build는 빌드하지 않는다');
    assert.equal(fs.readFileSync(runJar, 'utf8'), 'a 2');
  } finally {
    await fleet.stop();
  }
});

test('build: false(--no-build)면 빌드 없이 이미 있는 jar를 실행하고, jar가 없으면 이유를 알려준다', { skip }, async () => {
  const [pa, pb] = await Promise.all([freePort(), freePort()]);
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'a/build/libs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a/build/libs/a-1.0.jar'), 'a prebuilt');
  fs.mkdirSync(path.join(root, 'b'));
  const { config, out, output } = setup(
    {
      env: { JAVA_HOME: fakeJavaHome() },
      services: {
        a: { dir: 'a', build: build('a', root), jar: 'build/libs/*.jar', java_opts: `--port=${pa}`, port: pa },
        b: { dir: 'b', jar: 'build/libs/*.jar', port: pb },
      },
    },
    root,
  );
  const fleet = startFleet(config, [], { out, color: false, build: false });
  try {
    const rows = await fleet.ready;
    assert.deepEqual(rows.map((r) => [r.name, r.status]), [
      ['a', 'ready'],
      ['b', 'failed'],
    ]);
    assert.deepEqual(buildLog(root), []);
    assert.equal(fs.readFileSync(path.join(root, '.devfleet/jars/a.jar'), 'utf8'), 'a prebuilt');
    assert.match(output(), /✖ b no jar matches build\/libs\/\*\.jar in b\. Build it first, or add a build command\./);
  } finally {
    await fleet.stop();
  }
});
