#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { findConfig, loadConfig, CONFIG_NAMES } from './config.ts';
import { startFleet, planUp, formatSummary, formatTable, displayPath, type Plan } from './runner.ts';
import { composeArgs } from './infra.ts';
import { detectProject, renderConfig } from './init.ts';
import { isPortOpen, findListeners, describeListeners } from './ports.ts';
import { checkOnce, describeHealth } from './health.ts';
import type { Config } from './types.ts';
import { parseArgs, type Args } from './args.ts';

// Both src/cli.ts and dist/cli.js have package.json one level up.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const HELP = `devfleet ${version} — start local microservices in dependency order

Usage
  devfleet init                  analyze the project and create a devfleet.yaml draft
  devfleet up [name...]          start services (or groups) in dependency order
  devfleet status                show each service's port and health
  devfleet logs <name> [-f]      show a service's log file
  devfleet down                  stop the infra containers

Options for up
  --no-deps        don't start dependencies; only check that they are running
  --no-infra       leave Docker Compose infrastructure alone
  --down           also stop the infra containers on exit
  --only a,b       show only these services' logs on screen (files get everything)
  -q, --quiet      show only status messages on screen
  --dry-run        print the start plan without running anything

Common options
  -c, --config <file>   config file (default: search for ${CONFIG_NAMES[0]} from the current folder upwards)
  -h, --help / -v, --version
`;

function fail(message: string): never {
  process.stderr.write(`devfleet: ${message}\n`);
  process.exit(1);
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function requireConfig(opts: Args): Config {
  const configPath = str(opts.config);
  const file = configPath ? path.resolve(configPath) : findConfig();
  if (!file || !fs.existsSync(file)) {
    fail(`${CONFIG_NAMES[0]} not found. Run \`devfleet init\` in the project root first.`);
  }
  const config = loadConfig(file);
  if (config.errors.length) fail(`Invalid config (${file})\n  - ${config.errors.join('\n  - ')}`);
  return config;
}

function cmdInit(opts: Args): void {
  const root = process.cwd();
  const target = path.join(root, CONFIG_NAMES[0]);
  const project = detectProject(root);
  const text = renderConfig(project);
  if (opts.print) {
    process.stdout.write(text);
    return;
  }
  if (fs.existsSync(target) && !opts.force) fail(`${CONFIG_NAMES[0]} already exists. Use --force to overwrite it.`);
  fs.writeFileSync(target, text);
  console.log(`Created ${CONFIG_NAMES[0]}.`);
  console.log(`  Spring Boot apps (${project.apps.length}): ${project.apps.map((a) => a.name).join(', ') || 'none'}`);
  for (const app of project.apps.filter((a) => a.roles.length)) {
    console.log(`  ${app.roles.join(', ')} server: ${app.name} (apps that use it start after it)`);
  }
  if (project.infra.length) console.log(`  Infra (${project.composeFile}): ${project.infra.join(', ')}`);
  for (const warning of project.warnings) console.log(`  ! ${warning}`);
  console.log('Review it, then run `devfleet up`. Logs are written to .devfleet/logs, so add it to .gitignore.');
}

function printPlan(config: Config, plan: Plan, opts: Args): void {
  const rel = (p: string) => displayPath(config.root, p);
  if (opts.infra !== false && config.infra?.services.length) {
    const args = composeArgs(config.infra, 'up', ['-d']).map((a) => (path.isAbsolute(a) ? rel(a) : a));
    console.log(`infra: docker ${args.join(' ')}`);
  }
  if (plan.external.length) console.log(`Must already be running: ${plan.external.join(', ')}`);
  plan.waves.forEach((wave, i) => {
    console.log(`Wave ${i + 1} (started together)`);
    for (const name of wave) {
      const svc = config.services[name]!;
      const deps = svc.dependsOn.length ? ` ← ${svc.dependsOn.join(', ')}` : '';
      console.log(`  ${name}${deps}`);
      console.log(`    ${svc.cmd}  @ ${rel(svc.dir)}`);
      console.log(`    ready when: ${describeHealth(svc.health)}`);
    }
  });
}

async function cmdUp(opts: Args): Promise<void> {
  const config = requireConfig(opts);
  const only = str(opts.only);
  const runOpts = {
    deps: opts.deps !== false,
    infra: opts.infra !== false,
    stopInfra: Boolean(opts.down),
    quiet: Boolean(opts.quiet),
    only: only ? only.split(',').map((s) => s.trim()).filter(Boolean) : null,
  };
  if (opts['dry-run']) {
    try {
      printPlan(config, planUp(config, opts._, runOpts), opts);
    } catch (err) {
      fail((err as Error).message);
    }
    return;
  }

  let fleet: ReturnType<typeof startFleet>;
  try {
    fleet = startFleet(config, opts._, runOpts);
  } catch (err) {
    fail((err as Error).message);
  }
  const { logger } = fleet;
  let signals = 0;
  const shutdown = async (code: number) => {
    await fleet.stop();
    process.exit(code);
  };
  const onSignal = () => {
    signals += 1;
    if (signals === 1) {
      logger.system('Shutting down… (press Ctrl+C again to force)');
      void shutdown(130);
    } else {
      void fleet.stop({ force: true }).then(() => process.exit(130));
    }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const rows = await fleet.ready;
  if (signals) return;
  logger.system('');
  for (const line of formatSummary(rows).split('\n')) logger.system(line);
  const running = rows.filter((r) => r.pid);
  const failed = rows.filter((r) => r.status === 'failed' || r.status === 'skipped');
  logger.system('');
  if (!running.length) {
    logger.system(failed.length ? 'No services are running; exiting.' : 'No new services were started.');
    return shutdown(failed.length ? 1 : 0);
  }
  logger.system(`Logs: ${path.relative(process.cwd(), config.logDir) || '.'}/<service>.log · Ctrl+C stops everything`);

  await fleet.allExited;
  if (signals) return;
  logger.system('Every service started by devfleet has exited.');
  return shutdown(1);
}

async function cmdStatus(opts: Args): Promise<void> {
  const config = requireConfig(opts);
  const rows = await Promise.all(
    Object.values(config.services).map(async (svc): Promise<string[]> => {
      if (!svc.port) {
        const ok = svc.health.type !== 'none' && (await checkOnce(svc.health));
        return [svc.name, '', ok ? '● healthy' : '? no port', ''];
      }
      const port = String(svc.port);
      if (!(await isPortOpen(svc.port))) return [svc.name, port, '○ stopped', ''];
      const who = describeListeners(await findListeners(svc.port));
      const healthy = await checkOnce(svc.health);
      return [svc.name, port, healthy ? '● healthy' : '◐ port open, health failing', who];
    }),
  );
  console.log(formatTable([['SERVICE', 'PORT', 'STATUS', 'PROCESS'], ...rows]));
}

function cmdLogs(opts: Args): void {
  const config = requireConfig(opts);
  const name = opts._[0];
  if (!name) fail('Name a service, e.g. devfleet logs account-service -f');
  if (!config.services[name] && name !== 'infra') fail(`Unknown service: ${name}`);
  const file = path.join(config.logDir, `${name}.log`);
  if (!fs.existsSync(file)) fail(`No logs yet: ${path.relative(process.cwd(), file)}`);
  const args = ['-n', str(opts.n) ?? '100', ...(opts.follow ? ['-f'] : []), file];
  spawn('tail', args, { stdio: 'inherit' }).on('exit', (code) => process.exit(code ?? 0));
}

function cmdDown(opts: Args): void {
  const config = requireConfig(opts);
  if (!config.infra?.services.length) fail('No infra is configured.');
  spawn('docker', composeArgs(config.infra, 'stop'), { cwd: config.root, stdio: 'inherit' }).on('exit', (code) =>
    process.exit(code ?? 1),
  );
}

const COMMANDS: Record<string, (opts: Args) => void | Promise<void>> = {
  init: cmdInit,
  up: cmdUp,
  status: cmdStatus,
  ps: cmdStatus,
  logs: cmdLogs,
  down: cmdDown,
};

let opts: Args;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  fail((err as Error).message);
}
const command = opts._.shift();
if (opts.version) {
  console.log(version);
} else if (opts.help || !command || command === 'help') {
  process.stdout.write(HELP);
} else {
  const run = COMMANDS[command];
  if (!run) fail(`Unknown command: ${command}\n\n${HELP}`);
  Promise.resolve(run(opts)).catch((err: Error) => fail(err.stack ?? err.message));
}
