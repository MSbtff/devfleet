import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args: Record<string, string> = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k ?? '', v ?? 'true'];
  }),
);
const log = (line: string) => {
  if (args.log) fs.appendFileSync(args.log, `${line}\n`);
};

log(`start ${args.name}`);
if (args.daemon) log(`daemon ${daemon() ?? 'none'}`);

function daemon(): number | null {
  const registry = /-Dorg\.gradle\.daemon\.registry\.base=("?)(.+?)\1(?:\s|$)/.exec(process.env.GRADLE_OPTS ?? '')?.[2];
  if (!registry) return null;
  const dir = path.join(registry, '9.9');
  fs.mkdirSync(dir, { recursive: true });
  for (const file of fs.readdirSync(dir)) {
    const pid = Number(/^daemon-(\d+)\.out\.log$/.exec(file)?.[1]);
    try {
      if (pid && pid !== process.pid) {
        process.kill(pid, 0);
        if (fs.readFileSync(path.join(dir, file), 'utf8') === 'fake') return pid;
      }
    } catch {
    }
  }
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)', 'GradleDaemon'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  fs.writeFileSync(path.join(dir, `daemon-${child.pid}.out.log`), 'fake');
  return child.pid ?? null;
}
console.log(`compiling ${args.name}`);
setTimeout(() => {
  if (args['fail-if'] && fs.existsSync(args['fail-if'])) {
    console.error(`error: compilation failed for ${args.name}`);
    log(`fail ${args.name}`);
    process.exit(1);
  }
  const out = path.resolve(args.out ?? 'out.jar');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const builds = fs.existsSync(out) ? Number(fs.readFileSync(out, 'utf8').split(' ')[1] ?? 0) : 0;
  fs.writeFileSync(out, `${args.name} ${builds + 1}`);
  log(`end ${args.name}`);
}, Number(args.delay ?? 0));
