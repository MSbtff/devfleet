import fs from 'node:fs';
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
        let crash = Boolean(args['crash-after-ready']);
        if (crash && args.counter) {
          const runs = fs.existsSync(args.counter) ? Number(fs.readFileSync(args.counter, 'utf8')) : 0;
          fs.writeFileSync(args.counter, String(runs + 1));
          crash = runs < Number(args['crash-times'] ?? Infinity);
        }
        if (crash) {
          setTimeout(() => {
            console.error('fatal: lost database connection');
            process.exit(4);
          }, Number(args['crash-after-ready']));
        }
      });
  }, delay);
}
