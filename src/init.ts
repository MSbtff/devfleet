import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { parseEnv } from './config.ts';
import { waves } from './graph.ts';
import { RULES, type AppFacts, type DetectorRule } from './detectors.ts';
import { isRecord } from './types.ts';

const SKIP_DIRS = new Set(['node_modules', 'build', 'target', 'out', 'bin', 'dist', 'gradle', 'src']);
const BUILD_FILES = ['build.gradle.kts', 'build.gradle', 'pom.xml'] as const;
const APP_CONFIGS = ['application.yml', 'application.yaml', 'application.properties'] as const;
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'] as const;
const MAX_DEPTH = 3;

type BuildFile = (typeof BUILD_FILES)[number];

interface FoundApp {
  dir: string;
  buildFile: BuildFile;
  buildText: string;
  appConfig: string;
}

export interface DetectedApp extends FoundApp {
  name: string;
  composeName: string | null;
  port: number;
  health: string | null;
  runDir: string;
  /** Run command; empty in jar mode */
  cmd: string;
  /** Jar mode: the build that produces the jar */
  build: { cmd: string; dir: string } | null;
  /** Jar mode: the jar to run, relative to runDir */
  jar: string | null;
  facts: AppFacts;
  /** Server roles this app fills (e.g. Spring Cloud Config) */
  roles: string[];
  dependsOn: string[];
}

export interface DetectedProject {
  root: string;
  /** Apps are built once and run with java -jar instead of bootRun / spring-boot:run */
  jar: boolean;
  envFile: string | null;
  apps: DetectedApp[];
  composeFile: string | null;
  infra: string[];
  /** Things the user should check by hand */
  warnings: string[];
}

interface ComposeService {
  name: string;
  buildDir: string | null;
  image: string | null;
  dependsOn: string[];
}

interface ComposeProject {
  file: string;
  services: Record<string, ComposeService>;
}

/** Scans the project for Spring Boot apps and the Compose setup. */
export function detectProject(
  rootDir: string,
  { useDocker = true, jar = false }: { useDocker?: boolean; jar?: boolean } = {},
): DetectedProject {
  const root = path.resolve(rootDir);
  const envFile = fs.existsSync(path.join(root, '.env')) ? '.env' : null;
  const envVars = envFile ? parseEnv(fs.readFileSync(path.join(root, envFile), 'utf8')) : {};
  const found: FoundApp[] = [];
  walk(root, 0, found);
  const apps: DetectedApp[] = found.map((app) => ({
    ...app,
    ...describeApp(app, root, envVars, jar),
    name: '',
    composeName: null,
    roles: [],
    dependsOn: [],
  }));

  const compose = loadCompose(root, useDocker);
  const byDir = new Map(apps.map((a) => [a.dir, a]));
  const composeToApp = new Map<string, DetectedApp>();
  for (const svc of Object.values(compose?.services ?? {})) {
    const app = svc.buildDir ? byDir.get(svc.buildDir) : undefined;
    if (app && !app.composeName) {
      app.composeName = svc.name;
      composeToApp.set(svc.name, app);
    }
  }

  const usedNames = new Set<string>();
  for (const app of apps) {
    let name = app.composeName ?? kebab(path.basename(app.dir));
    while (usedNames.has(name)) name += '-2';
    usedNames.add(name);
    app.name = name;
  }

  // Follow Compose depends_on to collect app dependencies and required infra.
  const infra = new Set<string>();
  const addInfra = (name: string): void => {
    const svc = compose?.services[name];
    if (!svc || infra.has(name) || composeToApp.has(name)) return;
    infra.add(name);
    svc.dependsOn.forEach(addInfra);
  };
  if (compose) {
    for (const app of apps) {
      if (!app.composeName) continue;
      for (const dep of compose.services[app.composeName]?.dependsOn ?? []) {
        const target = composeToApp.get(dep);
        if (target) addDependency(apps, app, target);
        else addInfra(dep);
      }
    }
  }

  // Apps that use a Spring Cloud server (Config, Eureka, Consul, Nacos, ...) start after it.
  // Compose depends_on often omits this, so it is applied to Compose apps as well.
  const warnings: string[] = [];
  for (const rule of RULES) {
    const users = apps.filter((a) => rule.uses(a.facts));
    if (!users.length) continue;
    const server = rule.serves ? apps.find((a) => rule.serves!(a.facts)) : undefined;
    if (server) {
      server.roles.push(rule.label);
      for (const app of users) if (app !== server) addDependency(apps, app, server);
      continue;
    }
    const infraService = compose && findInfraService(rule, compose, composeToApp);
    if (infraService) {
      addInfra(infraService);
      continue;
    }
    warnings.push(
      `Apps use ${rule.label} (${users.map((a) => a.name).join(', ')}), ` +
        `but no ${rule.label} server was found. Start it yourself, or add it to compose.yaml and list it under infra.`,
    );
  }

  return {
    root,
    jar,
    envFile,
    apps,
    composeFile: compose?.file ?? null,
    infra: compose ? Object.keys(compose.services).filter((n) => infra.has(n)) : [],
    warnings,
  };
}

/** Makes app start after target. Skipped when it would create a cycle. */
function addDependency(apps: readonly DetectedApp[], app: DetectedApp, target: DetectedApp): boolean {
  if (app === target || app.dependsOn.includes(target.name)) return false;
  const byName = new Map(apps.map((a) => [a.name, a]));
  const seen = new Set<string>();
  const reaches = (from: DetectedApp): boolean => {
    if (from === app) return true;
    if (seen.has(from.name)) return false;
    seen.add(from.name);
    return from.dependsOn.some((dep) => {
      const next = byName.get(dep);
      return next ? reaches(next) : false;
    });
  };
  if (reaches(target)) return false;
  app.dependsOn.push(target.name);
  return true;
}

function findInfraService(
  rule: DetectorRule,
  compose: ComposeProject,
  composeToApp: ReadonlyMap<string, DetectedApp>,
): string | null {
  if (!rule.infraImage) return null;
  const pattern = rule.infraImage;
  const svc = Object.values(compose.services).find(
    (s) => !composeToApp.has(s.name) && (pattern.test(s.name) || (s.image != null && pattern.test(s.image))),
  );
  return svc?.name ?? null;
}

function walk(dir: string, depth: number, acc: FoundApp[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const names = new Set(entries.map((e) => e.name));
  const buildFile = BUILD_FILES.find((f) => names.has(f));
  if (buildFile) {
    const resources = path.join(dir, 'src', 'main', 'resources');
    const appConfig = APP_CONFIGS.map((f) => path.join(resources, f)).find((f) => fs.existsSync(f));
    const buildText = fs.readFileSync(path.join(dir, buildFile), 'utf8');
    if (appConfig && /org\.springframework\.boot|spring-boot/.test(buildText)) {
      acc.push({ dir, buildFile, buildText, appConfig });
    }
  }
  if (depth >= MAX_DEPTH) return;
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) {
      walk(path.join(dir, entry.name), depth + 1, acc);
    }
  }
}

function describeApp(app: FoundApp, root: string, envVars: Record<string, string>, jar: boolean) {
  const props = readSpringProps(app.appConfig);
  const resolve = (key: string): string | null =>
    props[key] == null ? null : resolvePlaceholders(String(props[key]), envVars);
  const port = toPort(resolve('server.port')) ?? 8080;
  const managementPort = toPort(resolve('management.server.port'));
  const basePath = trimSlash(resolve('management.endpoints.web.base-path') ?? '/actuator');
  const contextPath = trimSlash(resolve('server.servlet.context-path') ?? '');
  const hasActuator = /spring-boot-starter-actuator/.test(app.buildText);
  let health: string | null = null;
  if (hasActuator) {
    health =
      managementPort && managementPort !== port
        ? `http://127.0.0.1:${managementPort}${basePath}/health`
        : `http://127.0.0.1:${port}${contextPath}${basePath}/health`;
  }
  return {
    port,
    health,
    ...(jar ? jarCommand(app, root) : { ...runCommand(app, root), build: null, jar: null }),
    facts: { buildText: app.buildText, props },
  };
}

function runCommand(app: FoundApp, root: string): { runDir: string; cmd: string } {
  const gradle = app.buildFile !== 'pom.xml';
  const wrapper = gradle ? 'gradlew' : 'mvnw';
  const task = gradle ? 'bootRun' : 'spring-boot:run';
  if (fs.existsSync(path.join(app.dir, wrapper))) return { runDir: app.dir, cmd: `./${wrapper} ${task}` };
  // Use the root (multi-module) wrapper and run the subproject by path.
  for (let dir = path.dirname(app.dir); dir.startsWith(root); dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, wrapper))) {
      const rel = path.relative(dir, app.dir).split(path.sep);
      const cmd = gradle ? `./gradlew :${rel.join(':')}:bootRun` : `./mvnw -pl ${rel.join('/')} spring-boot:run`;
      return { runDir: dir, cmd };
    }
    if (dir === root) break;
  }
  return { runDir: app.dir, cmd: gradle ? 'gradle bootRun' : 'mvn spring-boot:run' };
}

/** Jar mode: build the app's jar with the nearest wrapper, then run it from the app's own folder. */
function jarCommand(app: FoundApp, root: string): Pick<DetectedApp, 'runDir' | 'cmd' | 'build' | 'jar'> {
  const gradle = app.buildFile !== 'pom.xml';
  const wrapper = gradle ? 'gradlew' : 'mvnw';
  const jar = gradle ? 'build/libs/*.jar' : 'target/*.jar';
  const result = (cmd: string, dir: string) => ({ runDir: app.dir, cmd: '', build: { cmd, dir }, jar });
  if (fs.existsSync(path.join(app.dir, wrapper))) {
    return result(gradle ? './gradlew bootJar' : './mvnw -q -DskipTests package', app.dir);
  }
  for (let dir = path.dirname(app.dir); dir.startsWith(root); dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, wrapper))) {
      const rel = path.relative(dir, app.dir).split(path.sep);
      const cmd = gradle ? `./gradlew :${rel.join(':')}:bootJar` : `./mvnw -q -DskipTests -pl ${rel.join('/')} -am package`;
      return result(cmd, dir);
    }
    if (dir === root) break;
  }
  return result(gradle ? 'gradle bootJar' : 'mvn -q -DskipTests package', app.dir);
}

/** Reads default-profile values from application.yml/properties into a flat key map. */
export function readSpringProps(file: string): Record<string, unknown> {
  const text = fs.readFileSync(file, 'utf8');
  const result: Record<string, unknown> = {};
  if (file.endsWith('.properties')) {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      const match = line.match(/^([^=:\s]+)\s*[=:]\s*(.*)$/);
      if (match) result[match[1]!] = match[2];
    }
    return result;
  }
  for (const doc of YAML.parseAllDocuments(text)) {
    const value: unknown = doc.toJS();
    if (!isRecord(value)) continue;
    const flat: Record<string, unknown> = {};
    flatten(value, '', flat);
    if (flat['spring.config.activate.on-profile'] || flat['spring.profiles']) continue;
    Object.assign(result, flat);
  }
  return result;
}

function flatten(value: Record<string, unknown>, prefix: string, out: Record<string, unknown>): void {
  for (const [key, child] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (isRecord(child)) flatten(child, full, out);
    else out[full] = child;
  }
}

/** Replaces ${NAME:default} with the .env value or the default. */
export function resolvePlaceholders(text: string, env: Record<string, string>): string {
  return text.replace(
    /\$\{([^:}]+)(?::([^}]*))?\}/g,
    (_, key: string, fallback: string | undefined) => env[key] ?? fallback ?? '',
  );
}

function loadCompose(root: string, useDocker: boolean): ComposeProject | null {
  const file = COMPOSE_FILES.find((f) => fs.existsSync(path.join(root, f)));
  if (!file) return null;
  let doc: unknown = null;
  if (useDocker) {
    // docker compose config works without the daemon and resolves extends, include, and variables.
    const res = spawnSync('docker', ['compose', '-f', file, 'config', '--format', 'json'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    });
    if (res.status === 0) {
      try {
        doc = JSON.parse(res.stdout);
      } catch {
        doc = null;
      }
    }
  }
  if (!doc) {
    try {
      doc = YAML.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    } catch {
      return null;
    }
  }
  const services: Record<string, ComposeService> = {};
  const rawServices = isRecord(doc) && isRecord(doc.services) ? doc.services : {};
  for (const [name, s] of Object.entries(rawServices)) {
    if (!isRecord(s)) continue;
    let buildDir: string | null = null;
    if (s.build) {
      const build = isRecord(s.build) ? s.build : { context: s.build };
      const context = path.resolve(root, String(build.context ?? '.'));
      buildDir = build.dockerfile ? path.dirname(path.resolve(context, String(build.dockerfile))) : context;
    }
    const dependsOn = Array.isArray(s.depends_on)
      ? s.depends_on.map(String)
      : Object.keys(isRecord(s.depends_on) ? s.depends_on : {});
    services[name] = { name, buildDir, image: typeof s.image === 'string' ? s.image : null, dependsOn };
  }
  return { file, services };
}

/** Renders the detection result as a commented devfleet.yaml. */
export function renderConfig(project: DetectedProject): string {
  const lines = [
    '# devfleet config — a draft generated by `devfleet init`. Edit it to fit your setup.',
    '# Run: devfleet up [service or group ...]',
    '',
  ];
  if (project.warnings.length) {
    lines.push('# Please check:', ...project.warnings.map((w) => `#   - ${w}`), '');
  }
  if (project.envFile) lines.push('# Environment file injected into every service', `env_file: ${scalar(project.envFile)}`, '');
  if (project.composeFile && project.infra.length) {
    lines.push(
      '# Infrastructure started with Docker Compose before the apps (DB, cache, message broker, ...)',
      'infra:',
      `  compose_file: ${scalar(project.composeFile)}`,
      `  services: [${project.infra.map(scalar).join(', ')}]`,
      '  # stop_on_exit: true   # also stop the infra when devfleet exits',
      '',
    );
  }
  if (project.jar) {
    lines.push(
      '# Jar mode: each app is built once and run with java -jar, so no Gradle daemon stays busy per app.',
      '# Builds run one at a time and reuse one daemon, which is stopped once the builds are done.',
      '# `devfleet restart <name>` rebuilds before restarting.',
      '# build_concurrency: 2   # build several apps at once (faster, but one daemon each)',
      '# gradle_daemon: keep    # keep the build daemon after builds (faster rebuilds, more memory)',
      '',
    );
  }
  lines.push('services:');
  const byName = Object.fromEntries(project.apps.map((a) => [a.name, a]));
  const ordered = waves(byName, project.apps.map((a) => a.name)).flat();
  for (const name of ordered) {
    const app = byName[name]!;
    if (app.roles.length) lines.push(`  # ${app.roles.join(', ')} server`);
    lines.push(`  ${scalar(name)}:`);
    lines.push(`    dir: ${scalar(path.relative(project.root, app.runDir) || '.')}`);
    if (app.build && app.jar) {
      if (app.build.dir === app.runDir) {
        lines.push(`    build: ${scalar(app.build.cmd)}`);
      } else {
        lines.push('    build:', `      cmd: ${scalar(app.build.cmd)}`, `      dir: ${scalar(path.relative(project.root, app.build.dir) || '.')}`);
      }
      lines.push(`    jar: ${scalar(app.jar)}`, '    java_opts: -XX:TieredStopAtLevel=1   # what bootRun uses; add -Xmx256m -XX:+UseSerialGC for even less memory');
    } else {
      lines.push(`    cmd: ${scalar(app.cmd)}`);
    }
    lines.push(`    port: ${app.port}`);
    if (app.dependsOn.length) lines.push(`    depends_on: [${app.dependsOn.map(scalar).join(', ')}]`);
    lines.push(app.health ? `    health: ${scalar(app.health)}` : '    # health: when omitted, the service is ready once the port accepts connections');
    lines.push('');
  }
  if (!project.apps.length) lines.push('  # No Spring Boot apps were found. Add your services here.', '');
  lines.push(
    '# Group services you often start together, then run `devfleet up core`.',
    '# groups:',
    `#   core: [${ordered.slice(0, 2).join(', ')}]`,
  );
  return `${lines.join('\n')}\n`;
}

function scalar(value: string): string {
  return /^[A-Za-z0-9_./][A-Za-z0-9_./ :=-]*$/.test(value) && !/: |\s#|:$|\s$/.test(value)
    ? value
    : JSON.stringify(value);
}

function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function toPort(value: string | null): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

function trimSlash(value: string): string {
  if (!value || value === '/') return '';
  return `/${value.replace(/^\/+|\/+$/g, '')}`;
}
