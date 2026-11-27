import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig } from '../src/config.ts';
import { findJar, startFleet } from '../src/runner.ts';
import { parseElapsed, stopDaemons, withDaemonRegistry } from '../src/gradle.ts';
import { spawn } from 'node:child_process';
import { isPortOpen } from '../src/ports.ts';
import { FAKE, fake, freePort, setup, sleep, tempDir } from './helpers.ts';

const FAKE_BUILD = fileURLToPath(new URL('./fixtures/fake-build.ts', import.meta.url));
const node = JSON.stringify(process.execPath);
const skip = process.platform === 'win32';

const build = (name: string, root: string, extra = '') =>
  `${node} ${JSON.stringify(FAKE_BUILD)} --name=${name} --out=build/libs/${name}-1.0.jar --log=${JSON.stringify(
    path.join(root, 'builds.log'),
  )} ${extra}`;

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

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const daemonPids = (root: string) => buildLog(root).flatMap((l) => (/^daemon (\d+)$/.exec(l) ? [Number(/\d+/.exec(l)![0])] : []));
async function eventually(check: () => boolean, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

test('gradle_daemon은 "stop"(기본값) 또는 "keep"', () => {
  assert.equal(normalizeConfig({ services: { a: { cmd: 'x' } } }, '/p').gradleDaemon, 'stop');
  assert.equal(normalizeConfig({ gradle_daemon: 'keep', services: { a: { cmd: 'x' } } }, '/p').gradleDaemon, 'keep');
  assert.deepEqual(normalizeConfig({ gradle_daemon: 'never', services: { a: { cmd: 'x' } } }, '/p').errors, [
    'gradle_daemon must be "stop" or "keep".',
  ]);
});

test('빌드가 끝나면 빌드가 띄운 Gradle 데몬만 멈추고, restart로 다시 빌드한 뒤에도 멈춘다', { skip }, async () => {
  const [pa, pb] = await Promise.all([freePort(), freePort()]);
  const root = tempDir();
  const registry = path.join(root, '.devfleet', 'gradle-daemons', '9.9');
  fs.mkdirSync(registry, { recursive: true });
  fs.writeFileSync(path.join(registry, `daemon-${process.pid}.out.log`), 'stale');
  const { config, out, output } = setup(
    {
      env: { JAVA_HOME: fakeJavaHome(), GRADLE_OPTS: '-Xmx64m' },
      services: {
        a: { build: build('a', root, '--daemon'), jar: 'build/libs/*.jar', java_opts: `--port=${pa}`, port: pa },
        b: { build: build('b', root, '--daemon'), jar: 'build/libs/*.jar', java_opts: `--port=${pb}`, port: pb },
      },
    },
    root,
  );
  const fleet = startFleet(config, [], { out, color: false });
  try {
    await fleet.ready;
    const [first, reused] = daemonPids(root);
    assert.ok(first, '빌드가 GRADLE_OPTS로 받은 레지스트리에 데몬을 띄웠다');
    assert.equal(reused, first, '두 번째 빌드는 같은 데몬을 다시 쓴다');
    assert.ok(await eventually(() => !alive(first)), '빌드가 끝나면 데몬을 멈춘다');
    assert.ok(await eventually(() => /stopped the Gradle daemon the builds used \(PID \d+\)/.test(output())));
    assert.doesNotMatch(output(), new RegExp(`PID [\\d, ]*\\b${process.pid}\\b`));

    assert.deepEqual(await fleet.restart(['a']), { ok: true });
    const again = daemonPids(root)[2]!;
    assert.notEqual(again, first);
    assert.ok(await eventually(() => !alive(again)), 'restart의 빌드가 띄운 데몬도 멈춘다');
  } finally {
    await fleet.stop();
  }
});

test('gradle_daemon: keep이면 빌드에 레지스트리를 주지 않아 평소 데몬을 그대로 쓴다', { skip }, async () => {
  const port = await freePort();
  const root = tempDir();
  const { config, out } = setup(
    {
      gradle_daemon: 'keep',
      env: { JAVA_HOME: fakeJavaHome() },
      services: { a: { build: build('a', root, '--daemon'), jar: 'build/libs/*.jar', java_opts: `--port=${port}`, port } },
    },
    root,
  );
  const fleet = startFleet(config, [], { out, color: false, quiet: true });
  try {
    await fleet.ready;
    assert.ok(buildLog(root).includes('daemon none'));
  } finally {
    await fleet.stop();
  }
});

test('빌드는 설정 파일 순서가 아니라 의존 순서로 슬롯을 잡는다', { skip }, async () => {
  const [pa, pb] = await Promise.all([freePort(), freePort()]);
  const root = tempDir();
  const { config, out } = setup(
    {
      env: { JAVA_HOME: fakeJavaHome() },
      services: {
        b: { build: build('b', root), jar: 'build/libs/b-*.jar', java_opts: `--port=${pb}`, port: pb, depends_on: ['a'] },
        a: { build: build('a', root), jar: 'build/libs/a-*.jar', java_opts: `--port=${pa}`, port: pa },
      },
    },
    root,
  );
  const fleet = startFleet(config, [], { out, color: false, quiet: true });
  try {
    await fleet.ready;
    assert.deepEqual(buildLog(root), ['start a', 'end a', 'start b', 'end b']);
  } finally {
    await fleet.stop();
  }
});

test('의존 서비스가 실패하면 아직 시작하지 않은 빌드는 취소한다', { skip }, async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'broken'), '');
  const { config, out, output } = setup(
    {
      env: { JAVA_HOME: fakeJavaHome() },
      services: {
        a: { build: build('a', root, `--fail-if=${path.join(root, 'broken')}`), jar: 'build/libs/a-*.jar', port: await freePort() },
        b: { build: build('b', root), jar: 'build/libs/b-*.jar', port: await freePort(), depends_on: ['a'] },
      },
    },
    root,
  );
  const fleet = startFleet(config, [], { out, color: false, quiet: true });
  try {
    const rows = await fleet.ready;
    assert.deepEqual(rows.map((r) => r.status), ['failed', 'skipped']);
    await sleep(300);
    assert.deepEqual(buildLog(root), ['start a', 'fail a'], 'b의 빌드는 돌지 않는다');
    assert.doesNotMatch(output(), /b building/);
  } finally {
    await fleet.stop();
  }
});

test('이미 떠 있는 서비스(IDE 등)는 빌드하지 않고 그대로 쓴다', { skip }, async () => {
  const port = await freePort();
  const root = tempDir();
  const running = spawn(fake(`--port=${port}`), { shell: true, detached: true, stdio: 'ignore' });
  const { config, out, output } = setup(
    { env: { JAVA_HOME: fakeJavaHome() }, services: { a: { build: build('a', root), jar: 'build/libs/*.jar', port } } },
    root,
  );
  try {
    for (let i = 0; i < 100 && !(await isPortOpen(port)); i++) await sleep(50);
    const fleet = startFleet(config, [], { out, color: false, quiet: true });
    try {
      const rows = await fleet.ready;
      assert.equal(rows[0]?.status, 'external');
      assert.deepEqual(buildLog(root), []);
      assert.match(output(), /a already running on port \d+; skipping the build/);
    } finally {
      await fleet.stop();
    }
  } finally {
    process.kill(-running.pid!, 'SIGKILL');
  }
});

test('GRADLE_OPTS: 기존 값 뒤에 붙이고, 셸에 특별한 문자는 백슬래시로 이스케이프한다', { skip }, () => {
  assert.deepEqual(withDaemonRegistry({ GRADLE_OPTS: '-Xmx64m' }, '/p/.devfleet/gradle-daemons').GRADLE_OPTS,
    '-Xmx64m -Dorg.gradle.daemon.registry.base=/p/.devfleet/gradle-daemons');
  assert.equal(withDaemonRegistry({}, `/a b/it's $x`).GRADLE_OPTS, "-Dorg.gradle.daemon.registry.base=/a\\ b/it\\'s\\ \\$x");
});

test('parseElapsed: ps의 [[dd-]hh:]mm:ss', () => {
  assert.equal(parseElapsed('00:07'), 7);
  assert.equal(parseElapsed('12:34'), 754);
  assert.equal(parseElapsed('01:02:03'), 3723);
  assert.equal(parseElapsed('2-01:00:00'), 2 * 86400 + 3600);
  assert.equal(parseElapsed('soon'), null);
});

test('stopDaemons: 로그보다 늦게 시작한 프로세스는 PID가 재사용된 것이므로 GradleDaemon이어도 멈추지 않는다', { skip }, async () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, '9.9'));
  const spawnDaemon = () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)', 'GradleDaemon'], { stdio: 'ignore' });
    return child;
  };
  const ours = spawnDaemon();
  const other = spawnDaemon();
  try {
    await sleep(200);
    fs.writeFileSync(path.join(dir, '9.9', `daemon-${ours.pid}.out.log`), 'live');
    const old = path.join(dir, '9.9', `daemon-${other.pid}.out.log`);
    fs.writeFileSync(old, 'old');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(old, past, past);
    fs.writeFileSync(path.join(dir, '9.9', 'daemon-999999.out.log'), 'gone');

    assert.deepEqual(await stopDaemons(dir), [ours.pid]);
    assert.equal(alive(ours.pid!), false);
    assert.equal(alive(other.pid!), true);
    assert.deepEqual(fs.readdirSync(path.join(dir, '9.9')), [], '쓸모없는 로그는 지운다');
  } finally {
    ours.kill('SIGKILL');
    other.kill('SIGKILL');
  }
});

test('heapWarning: 힙 제한 없는 jar 서비스가 메모리에 비해 많으면 경고한다', async () => {
  const { heapWarning } = await import('../src/runner.ts');
  const jar = (javaOpts = '', env: Record<string, string> = {}) => ({ jar: 'build/libs/*.jar', javaOpts, env });
  const GB = 1024 ** 3;
  const nine = Array.from({ length: 9 }, () => jar('-XX:TieredStopAtLevel=1'));
  assert.match(
    heapWarning(nine, {}, 16 * GB) ?? '',
    /^9 jar services have no heap limit, so each may grow to 4 GB \(a quarter of this machine's 16 GB\)/,
  );
  assert.equal(heapWarning(nine, {}, 48 * GB), null, '48GB에서 9개는 괜찮다');
  assert.equal(heapWarning(Array.from({ length: 9 }, () => jar('-Xmx256m')), {}, 16 * GB), null);
  assert.equal(heapWarning(nine, { JAVA_TOOL_OPTIONS: '-XX:MaxRAMPercentage=5' }, 16 * GB), null, 'JAVA_TOOL_OPTIONS도 본다');
  assert.equal(heapWarning([...Array.from({ length: 9 }, () => jar('', { JDK_JAVA_OPTIONS: '-Xmx1g' }))], {}, 16 * GB), null);
  assert.equal(heapWarning(Array.from({ length: 9 }, () => ({ jar: null, javaOpts: '', env: {} })), {}, 16 * GB), null, 'bootRun 등 cmd 서비스는 셀 수 없다');
});

test('최상위 java_opts는 모든 서비스 앞에 붙고, 서비스 값이 뒤에 와서 이긴다. 여러 줄은 한 줄로 합친다', () => {
  const config = normalizeConfig(
    {
      java_opts: '-XX:TieredStopAtLevel=1\n-Xmx256m\n',
      services: {
        a: { jar: 'a.jar' },
        b: { jar: 'b.jar', java_opts: '-Xmx1g' },
      },
    },
    '/p',
  );
  assert.deepEqual(config.errors, []);
  assert.equal(config.services.a?.javaOpts, '-XX:TieredStopAtLevel=1 -Xmx256m');
  assert.equal(config.services.b?.javaOpts, '-XX:TieredStopAtLevel=1 -Xmx256m -Xmx1g');
  assert.deepEqual(normalizeConfig({ java_opts: ['-Xmx1g'], services: { a: { jar: 'a.jar', java_opts: 512 } } }, '/p').errors, [
    'java_opts must be a string of JVM options, e.g. "-Xmx256m -XX:+UseSerialGC".',
    'a: java_opts must be a string of JVM options, e.g. "-Xmx256m -XX:+UseSerialGC".',
  ]);
});
