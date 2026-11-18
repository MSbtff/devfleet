// 테스트용 가짜 서비스.
// 인자: --port=N --delay=ms --crash=ms --crash-after-ready=ms --orphan --status=503
//       --ignore=SIGINT,SIGTERM --print-env=A,B
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args: Record<string, string> = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k ?? '', v ?? 'true'];
  }),
);
const port = Number(args.port);
const delay = Number(args.delay ?? 0);
const ignored = new Set((args.ignore ?? '').split(',').filter(Boolean));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (ignored.has(signal)) console.log(`ignored ${signal}`);
    else process.exit(0);
  });
}

if (args['print-env']) {
  for (const key of args['print-env'].split(',')) console.log(`env ${key}=${process.env[key] ?? '<unset>'}`);
}

if (args.crash) {
  console.log('starting then crashing');
  setTimeout(() => {
    console.error('boom: fatal startup error');
    process.exit(3);
  }, Number(args.crash));
} else if (args.orphan) {
  // Gradle 데몬처럼 앱을 다른 프로세스 그룹에 띄우고, 자신은 신호를 받으면 그냥 끝난다.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), `--port=${port}`, `--delay=${delay}`], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  console.log(`client: launched app pid ${child.pid}`);
  setInterval(() => {}, 1000);
} else {
  console.log(`starting on ${port} FAKE_VAR=${process.env.FAKE_VAR ?? ''}`);
  setTimeout(() => {
    http
      .createServer((req, res) => {
        res.statusCode = Number(args.status ?? 200);
        res.end('ok');
      })
      .listen(port, () => {
        console.log(`listening ${port}`);
        if (args['crash-after-ready']) {
          setTimeout(() => {
            console.error('fatal: lost database connection');
            process.exit(4);
          }, Number(args['crash-after-ready']));
        }
      });
  }, delay);
}
