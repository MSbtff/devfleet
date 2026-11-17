#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { findConfig, loadConfig, CONFIG_NAMES } from '../src/config.js';
import { startFleet, planUp, formatSummary, infraArgs } from '../src/runner.js';
import { detectProject, renderConfig } from '../src/init.js';
import { isPortOpen, findListeners, describeListeners } from '../src/ports.js';
import { checkOnce, describeHealth } from '../src/health.js';

const { version } = createRequire(import.meta.url)('../package.json');

const HELP = `devfleet ${version} — 로컬 MSA 서비스를 한 번에 띄우는 CLI

사용법
  devfleet init                  프로젝트를 분석해 devfleet.yaml 초안 생성
  devfleet up [이름...]           서비스(또는 그룹)를 의존성 순서대로 실행
  devfleet status                각 서비스의 포트·헬스 상태 확인
  devfleet logs <이름> [-f]       서비스 로그 파일 보기
  devfleet down                  infra 컨테이너 정지

up 옵션
  --no-deps        의존 서비스는 띄우지 않고, 이미 실행 중인지 확인만 함
  --no-infra       Docker Compose 인프라를 건드리지 않음
  --down           종료할 때 인프라 컨테이너도 정지
  --only a,b       화면에는 지정한 서비스 로그만 표시 (파일에는 모두 기록)
  -q, --quiet      화면에는 상태 메시지만 표시
  --dry-run        실제로 실행하지 않고 실행 계획만 출력

공통 옵션
  -c, --config <파일>   설정 파일 경로 (기본: 현재 폴더부터 위로 ${CONFIG_NAMES[0]} 탐색)
  -h, --help / -v, --version
`;

function parseArgs(argv) {
  const opts = { _: [] };
  const valueFlags = new Set(['config', 'only', 'n']);
  const alias = { c: 'config', q: 'quiet', f: 'follow', h: 'help', v: 'version' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      opts._.push(...argv.slice(i + 1));
      break;
    }
    const long = arg.match(/^--([^=]+)(?:=(.*))?$/);
    const short = arg.match(/^-([A-Za-z])$/);
    if (!long && !short) {
      opts._.push(arg);
      continue;
    }
    let key = long ? long[1] : (alias[short[1]] ?? short[1]);
    let value = long?.[2];
    if (key.startsWith('no-')) {
      opts[key.slice(3)] = false;
      continue;
    }
    if (valueFlags.has(key)) {
      value ??= argv[++i];
      if (value == null) fail(`--${key}에 값이 필요합니다.`);
      opts[key] = value;
    } else {
      opts[key] = value ?? true;
    }
  }
  return opts;
}

function fail(message) {
  process.stderr.write(`devfleet: ${message}\n`);
  process.exit(1);
}

function requireConfig(opts) {
  const file = opts.config ? path.resolve(opts.config) : findConfig();
  if (!file || !fs.existsSync(file)) {
    fail(`${CONFIG_NAMES[0]}을 찾지 못했습니다. 프로젝트 루트에서 \`devfleet init\`을 먼저 실행하세요.`);
  }
  const config = loadConfig(file);
  if (config.errors.length) fail(`설정 오류 (${file})\n  - ${config.errors.join('\n  - ')}`);
  return config;
}

async function cmdInit(opts) {
  const root = process.cwd();
  const target = path.join(root, CONFIG_NAMES[0]);
  const project = detectProject(root);
  const text = renderConfig(project);
  if (opts.print) {
    process.stdout.write(text);
    return;
  }
  if (fs.existsSync(target) && !opts.force) fail(`${CONFIG_NAMES[0]}이 이미 있습니다. 덮어쓰려면 --force를 붙이세요.`);
  fs.writeFileSync(target, text);
  console.log(`${CONFIG_NAMES[0]}을 만들었습니다.`);
  console.log(`  Spring Boot 앱 ${project.apps.length}개: ${project.apps.map((a) => a.name).join(', ') || '없음'}`);
  if (project.infra.length) console.log(`  인프라 (${project.composeFile}): ${project.infra.join(', ')}`);
  console.log('내용을 확인한 뒤 `devfleet up`으로 실행하세요. 로그는 .devfleet/logs에 쌓이니 .gitignore에 추가하세요.');
}

function printPlan(config, plan, opts) {
  const rel = (p) => path.relative(config.root, p) || '.';
  if (opts.infra !== false && config.infra?.services.length) {
    console.log(`infra: docker ${infraArgs(config, 'up', ['-d', '--wait']).map((a) => (path.isAbsolute(a) ? rel(a) : a)).join(' ')}`);
  }
  if (plan.external.length) console.log(`이미 실행 중이어야 함: ${plan.external.join(', ')}`);
  plan.waves.forEach((wave, i) => {
    console.log(`${i + 1}단계 (동시 시작)`);
    for (const name of wave) {
      const svc = config.services[name];
      const deps = svc.dependsOn.length ? ` ← ${svc.dependsOn.join(', ')}` : '';
      console.log(`  ${name}${deps}`);
      console.log(`    ${svc.cmd}  @ ${rel(svc.dir)}`);
      console.log(`    준비 확인: ${describeHealth(svc.health)}`);
    }
  });
}

async function cmdUp(opts) {
  const config = requireConfig(opts);
  const runOpts = {
    deps: opts.deps !== false,
    infra: opts.infra !== false,
    stopInfra: Boolean(opts.down),
    quiet: Boolean(opts.quiet),
    only: opts.only ? String(opts.only).split(',').map((s) => s.trim()).filter(Boolean) : null,
  };
  if (opts['dry-run']) {
    let plan;
    try {
      plan = planUp(config, opts._, runOpts);
    } catch (err) {
      fail(err.message);
    }
    printPlan(config, plan, opts);
    return;
  }

  let fleet;
  try {
    fleet = startFleet(config, opts._, runOpts);
  } catch (err) {
    fail(err.message);
  }
  const { logger } = fleet;
  let signals = 0;
  const shutdown = async (code) => {
    await fleet.stop();
    process.exit(code);
  };
  const onSignal = () => {
    signals += 1;
    if (signals === 1) {
      logger.system('종료합니다… (한 번 더 Ctrl+C: 강제 종료)');
      shutdown(130);
    } else {
      fleet.stop({ force: true }).then(() => process.exit(130));
    }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const rows = await fleet.ready;
  if (signals) return;
  logger.system('');
  for (const line of formatSummary(rows).split('\n')) logger.system(line);
  const running = rows.filter((r) => r.pid);
  const failed = rows.filter((r) => ['failed', 'skipped'].includes(r.status));
  logger.system('');
  if (!running.length) {
    logger.system(failed.length ? '실행 중인 서비스가 없어 종료합니다.' : '새로 띄운 서비스가 없습니다.');
    return shutdown(failed.length ? 1 : 0);
  }
  logger.system(`로그: ${path.relative(process.cwd(), config.logDir) || '.'}/<서비스>.log · Ctrl+C로 모두 종료`);

  await fleet.allExited;
  if (signals) return;
  logger.system('직접 띄운 서비스가 모두 종료됐습니다.');
  shutdown(1);
}

async function cmdStatus(opts) {
  const config = requireConfig(opts);
  const rows = await Promise.all(
    Object.values(config.services).map(async (svc) => {
      if (!svc.port) {
        const ok = svc.health.type !== 'none' && (await checkOnce(svc.health));
        return [svc.name, '', ok ? '● 정상' : '? 포트 없음', ''];
      }
      if (!(await isPortOpen(svc.port))) return [svc.name, svc.port, '○ 중지', ''];
      const who = describeListeners(await findListeners(svc.port));
      const healthy = await checkOnce(svc.health);
      return [svc.name, svc.port, healthy ? '● 정상' : '◐ 포트 열림, 헬스 실패', who];
    }),
  );
  const header = ['서비스', '포트', '상태', '프로세스'];
  const width = (s) => [...String(s)].reduce((w, ch) => w + (/[가-힣]/.test(ch) ? 2 : 1), 0);
  const widths = header.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i]))));
  for (const row of [header, ...rows]) {
    console.log(row.map((c, i) => String(c) + ' '.repeat(widths[i] - width(c))).join('  ').trimEnd());
  }
}

function cmdLogs(opts) {
  const config = requireConfig(opts);
  const name = opts._[0];
  if (!name) fail('서비스 이름을 지정하세요. 예: devfleet logs account-service -f');
  if (!config.services[name] && name !== 'infra') fail(`알 수 없는 서비스: ${name}`);
  const file = path.join(config.logDir, `${name}.log`);
  if (!fs.existsSync(file)) fail(`아직 로그가 없습니다: ${path.relative(process.cwd(), file)}`);
  const args = ['-n', String(opts.n ?? 100), ...(opts.follow ? ['-f'] : []), file];
  spawn('tail', args, { stdio: 'inherit' }).on('exit', (code) => process.exit(code ?? 0));
}

function cmdDown(opts) {
  const config = requireConfig(opts);
  if (!config.infra?.services.length) fail('설정에 infra가 없습니다.');
  spawn('docker', infraArgs(config, 'stop'), { cwd: config.root, stdio: 'inherit' }).on('exit', (code) =>
    process.exit(code ?? 1),
  );
}

const opts = parseArgs(process.argv.slice(2));
const command = opts._.shift();
if (opts.version) {
  console.log(version);
} else if (opts.help || !command || command === 'help') {
  process.stdout.write(HELP);
} else {
  const commands = { init: cmdInit, up: cmdUp, status: cmdStatus, ps: cmdStatus, logs: cmdLogs, down: cmdDown };
  if (!commands[command]) fail(`알 수 없는 명령: ${command}\n\n${HELP}`);
  Promise.resolve(commands[command](opts)).catch((err) => fail(err.stack ?? err.message));
}
