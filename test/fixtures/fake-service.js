// 테스트용 가짜 서비스. 인자: --port=N --delay=ms --crash=ms --orphan --status=503
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const port = Number(args.port);
const delay = Number(args.delay ?? 0);

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

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
      .listen(port, () => console.log(`listening ${port}`));
  }, delay);
}
