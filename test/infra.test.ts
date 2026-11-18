import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { evaluateInfra, parseComposePs, type ContainerState } from '../src/infra.ts';
import { normalizeConfig } from '../src/config.ts';
import { startFleet } from '../src/runner.ts';

const c = (service: string, state: string, health = '', exitCode = 0): ContainerState => ({
  service,
  state,
  health,
  exitCode,
});

test('compose ps 출력을 NDJSON과 JSON 배열 모두 읽는다', () => {
  const line = (s: string, state: string, health: string, code: number) =>
    JSON.stringify({ Service: s, State: state, Health: health, ExitCode: code, Name: `p-${s}-1` });
  const ndjson = `${line('mariadb', 'running', 'healthy', 0)}\n${line('database-init', 'exited', '', 0)}\n`;
  const expected = [c('mariadb', 'running', 'healthy'), c('database-init', 'exited')];
  assert.deepEqual(parseComposePs(ndjson), expected);
  assert.deepEqual(parseComposePs(`[${ndjson.trim().split('\n').join(',')}]`), expected);
  assert.deepEqual(parseComposePs('\n'), []);
});

test('한 번 실행하고 정상 종료한 컨테이너는 준비 완료로 본다', () => {
  const services = ['mariadb', 'database-init', 'redis'];
  assert.deepEqual(
    evaluateInfra([c('mariadb', 'running', 'healthy'), c('database-init', 'exited'), c('redis', 'running')], services),
    { ready: true, failures: [], waiting: [] },
  );
  const starting = evaluateInfra([c('mariadb', 'running', 'starting'), c('database-init', 'created')], services);
  assert.equal(starting.ready, false);
  assert.deepEqual(starting.waiting, ['mariadb (running, starting)', 'database-init (created)', 'redis (no container)']);
  const failed = evaluateInfra(
    [c('mariadb', 'running', 'unhealthy'), c('database-init', 'exited', '', 1), c('redis', 'running')],
    services,
  );
  assert.deepEqual(failed.failures, ['mariadb: unhealthy', 'database-init: exited (exit 1)']);
});

/** docker 대신 쓸 가짜 명령. ps를 두 번째 호출할 때부터 준비 완료 상태를 돌려준다. */
function fakeDocker(initExit: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devfleet-docker-'));
  const ready = [
    { Service: 'mariadb', State: 'running', Health: 'healthy', ExitCode: 0 },
    { Service: 'database-init', State: 'exited', Health: '', ExitCode: initExit },
  ];
  const starting = [
    { Service: 'mariadb', State: 'running', Health: 'starting', ExitCode: 0 },
    { Service: 'database-init', State: 'created', Health: '', ExitCode: 0 },
  ];
  const ndjson = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(path.join(dir, 'starting.json'), ndjson(starting));
  fs.writeFileSync(path.join(dir, 'ready.json'), ndjson(ready));
  fs.writeFileSync(
    path.join(dir, 'docker'),
    `#!/bin/sh
D="${dir}"
echo "$*" >> "$D/calls.log"
case " $* " in
  *" up "*) echo " Container fake Started"; exit 0 ;;
  *" ps "*)
    if [ -f "$D/seen" ]; then cat "$D/ready.json"; else touch "$D/seen"; cat "$D/starting.json"; fi
    exit 0 ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  return dir;
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function runWithFakeDocker(initExit: number) {
  const dockerDir = fakeDocker(initExit);
  const port = await freePort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devfleet-infra-run-'));
  const fake = fileURLToPath(new URL('./fixtures/fake-service.ts', import.meta.url));
  const config = normalizeConfig(
    {
      infra: { compose_file: 'compose.yaml', services: ['mariadb', 'database-init'] },
      services: { app: { cmd: `${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} --port=${port}`, port } },
    },
    root,
  );
  const out = new PassThrough();
  let text = '';
  out.on('data', (chunk) => (text += chunk));
  const originalPath = process.env.PATH;
  process.env.PATH = `${dockerDir}${path.delimiter}${originalPath}`;
  try {
    const fleet = startFleet(config, [], { out, color: false, quiet: true });
    const rows = await fleet.ready;
    await fleet.stop();
    return { rows, text, calls: fs.readFileSync(path.join(dockerDir, 'calls.log'), 'utf8') };
  } finally {
    process.env.PATH = originalPath;
  }
}

test('초기화 컨테이너가 exit 0으로 끝나면 인프라 준비로 보고 앱을 띄운다', async () => {
  const { rows, text, calls } = await runWithFakeDocker(0);
  assert.equal(rows[0]?.status, 'ready');
  assert.match(text, /infra waiting for: mariadb \(running, starting\), database-init \(created\)/);
  assert.match(text, /✔ infra ready in/);
  assert.doesNotMatch(calls, /--wait/, 'compose --wait는 one-shot 컨테이너를 실패로 보므로 쓰지 않는다');
});

test('초기화 컨테이너가 실패하면 원인과 확인 명령을 보여주고 앱은 건너뛴다', async () => {
  const { rows, text } = await runWithFakeDocker(1);
  assert.equal(rows[0]?.status, 'skipped');
  assert.match(text, /not ready: database-init: exited \(exit 1\)/);
  assert.match(text, /docker compose logs database-init/);
});
