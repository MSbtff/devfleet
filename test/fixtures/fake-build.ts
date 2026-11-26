// 테스트용 가짜 빌드.
// 인자: --name=a --out=<jar 경로> --log=<기록 파일> --delay=ms --fail-if=<파일: 있으면 실패>
// 시작과 끝을 기록 파일에 한 줄씩 남기고, 성공하면 jar 대신 이름과 빌드 횟수를 쓴 파일을 만든다.
import fs from 'node:fs';
import path from 'node:path';

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
