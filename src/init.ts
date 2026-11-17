import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { parseEnv } from './config.ts';
import { waves } from './graph.ts';
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
  cmd: string;
  isEurekaServer: boolean;
  usesEureka: boolean;
  dependsOn: string[];
}

export interface DetectedProject {
  root: string;
  envFile: string | null;
  apps: DetectedApp[];
  composeFile: string | null;
  infra: string[];
}

interface ComposeService {
  name: string;
  buildDir: string | null;
  dependsOn: string[];
}

interface ComposeProject {
  file: string;
  services: Record<string, ComposeService>;
}

/** 프로젝트를 훑어 Spring Boot 앱과 Compose 구성을 찾는다. */
export function detectProject(rootDir: string, { useDocker = true }: { useDocker?: boolean } = {}): DetectedProject {
  const root = path.resolve(rootDir);
  const envFile = fs.existsSync(path.join(root, '.env')) ? '.env' : null;
  const envVars = envFile ? parseEnv(fs.readFileSync(path.join(root, envFile), 'utf8')) : {};
  const found: FoundApp[] = [];
  walk(root, 0, found);
  const apps: DetectedApp[] = found.map((app) => ({
    ...app,
    ...describeApp(app, root, envVars),
    name: '',
    composeName: null,
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

  // Compose의 depends_on을 따라가며 앱 간 의존성과 필요한 인프라를 모은다.
  const infra = new Set<string>();
  if (compose) {
    for (const app of apps) {
      if (!app.composeName) continue;
      const visit = (dep: string): void => {
        const target = composeToApp.get(dep);
        if (target) {
          if (!app.dependsOn.includes(target.name)) app.dependsOn.push(target.name);
          return;
        }
        const svc = compose.services[dep];
        if (infra.has(dep) || !svc) return;
        infra.add(dep);
        svc.dependsOn.forEach(visit);
      };
      compose.services[app.composeName]?.dependsOn.forEach(visit);
    }
  }
  // Compose에 없으면 Eureka 의존성으로 순서를 추정한다.
  const eurekaServer = apps.find((a) => a.isEurekaServer);
  if (eurekaServer) {
    for (const app of apps) {
      if (!app.composeName && app !== eurekaServer && app.usesEureka && !app.dependsOn.includes(eurekaServer.name)) {
        app.dependsOn.push(eurekaServer.name);
      }
    }
  }

  return {
    root,
    envFile,
    apps,
    composeFile: compose?.file ?? null,
    infra: compose ? Object.keys(compose.services).filter((n) => infra.has(n)) : [],
  };
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

function describeApp(app: FoundApp, root: string, envVars: Record<string, string>) {
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
    ...runCommand(app, root),
    isEurekaServer: /eureka-server/.test(app.buildText),
    usesEureka: /eureka-client|spring-cloud-starter-gateway/.test(app.buildText),
  };
}

function runCommand(app: FoundApp, root: string): { runDir: string; cmd: string } {
  const gradle = app.buildFile !== 'pom.xml';
  const wrapper = gradle ? 'gradlew' : 'mvnw';
  const task = gradle ? 'bootRun' : 'spring-boot:run';
  if (fs.existsSync(path.join(app.dir, wrapper))) return { runDir: app.dir, cmd: `./${wrapper} ${task}` };
  // 루트(멀티 모듈)의 래퍼를 찾아 하위 프로젝트를 지정해 실행한다.
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

/** application.yml/properties에서 기본 프로필 값을 평평한 key 맵으로 읽는다. */
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

/** ${NAME:default} 형식을 .env 값 또는 기본값으로 바꾼다. */
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
    // docker compose config는 데몬 없이도 동작하며 extends/include/환경변수를 모두 반영해 준다.
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
    services[name] = { name, buildDir, dependsOn };
  }
  return { file, services };
}

/** 감지 결과를 주석이 달린 devfleet.yaml 텍스트로 만든다. */
export function renderConfig(project: DetectedProject): string {
  const lines = [
    '# devfleet 설정 파일 — `devfleet init`이 만든 초안입니다. 필요에 맞게 고쳐 쓰세요.',
    '# 실행: devfleet up [서비스 또는 그룹 ...]',
    '',
  ];
  if (project.envFile) lines.push('# 모든 서비스에 넣을 환경변수 파일', `env_file: ${scalar(project.envFile)}`, '');
  if (project.composeFile && project.infra.length) {
    lines.push(
      '# 앱보다 먼저 Docker Compose로 띄울 인프라 (DB, 캐시, 메시지 브로커 등)',
      'infra:',
      `  compose_file: ${scalar(project.composeFile)}`,
      `  services: [${project.infra.map(scalar).join(', ')}]`,
      '  # stop_on_exit: true   # devfleet을 끌 때 인프라도 함께 정지',
      '',
    );
  }
  lines.push('services:');
  const byName = Object.fromEntries(project.apps.map((a) => [a.name, a]));
  const ordered = waves(byName, project.apps.map((a) => a.name)).flat();
  for (const name of ordered) {
    const app = byName[name]!;
    lines.push(`  ${scalar(name)}:`);
    lines.push(`    dir: ${scalar(path.relative(project.root, app.runDir) || '.')}`);
    lines.push(`    cmd: ${scalar(app.cmd)}`);
    lines.push(`    port: ${app.port}`);
    if (app.dependsOn.length) lines.push(`    depends_on: [${app.dependsOn.map(scalar).join(', ')}]`);
    lines.push(app.health ? `    health: ${scalar(app.health)}` : '    # health: 미지정 시 포트가 열리면 준비된 것으로 봅니다');
    lines.push('');
  }
  if (!project.apps.length) lines.push('  # 찾은 Spring Boot 앱이 없습니다. 직접 추가하세요.', '');
  lines.push(
    '# 자주 함께 띄우는 서비스를 묶어 두면 `devfleet up core`처럼 쓸 수 있습니다.',
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
