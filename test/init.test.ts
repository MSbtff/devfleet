import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { detectProject, renderConfig, resolvePlaceholders } from '../src/init.ts';
import { normalizeConfig } from '../src/config.ts';

function write(root: string, rel: string, text: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const BOOT = "plugins { id 'org.springframework.boot' version '3.5.0' }\n";
const ACTUATOR = "implementation 'org.springframework.boot:spring-boot-starter-actuator'\n";

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devfleet-init-'));
  write(root, '.env', 'ACCOUNT_SERVER_PORT=7171\n');
  // Eureka 서버: 자체 gradlew 보유
  write(root, 'eurekaServer/build.gradle', BOOT + ACTUATOR + "implementation 'spring-cloud-starter-netflix-eureka-server'\n");
  write(root, 'eurekaServer/gradlew', '');
  write(root, 'eurekaServer/src/main/resources/application.yaml', 'server:\n  port: "${EUREKA_PORT:8761}"\n');
  // Account: 자체 gradlew, .env로 포트 덮어씀, 별도 management 포트, 프로필 문서는 무시
  write(root, 'AccountService/build.gradle', BOOT + ACTUATOR + "implementation 'eureka-client'\n");
  write(root, 'AccountService/gradlew', '');
  write(
    root,
    'AccountService/src/main/resources/application.yml',
    'server:\n  port: "${ACCOUNT_SERVER_PORT:7071}"\nmanagement:\n  server:\n    port: 9071\n---\nspring:\n  config:\n    activate:\n      on-profile: docker\nserver:\n  port: 80\n',
  );
  // 멀티 모듈: 루트 gradlew를 쓰는 하위 프로젝트, properties 설정, actuator 없음
  write(root, 'gradlew', '');
  write(root, 'apps/menus/build.gradle.kts', 'plugins { id("org.springframework.boot") }\n');
  write(root, 'apps/menus/src/main/resources/application.properties', 'server.port=7072\nserver.servlet.context-path=/menus\n');
  // 앱이 아닌 공유 라이브러리
  write(root, 'shared/lib/build.gradle', BOOT);
  write(
    root,
    'compose.yaml',
    `services:
  mariadb: { image: mariadb:10.11 }
  database-init: { image: mariadb:10.11, depends_on: [mariadb] }
  redis: { image: redis:8 }
  grafana: { image: grafana/grafana }
  eureka-server: { build: { context: ., dockerfile: eurekaServer/Dockerfile } }
  account-service:
    build: { context: ., dockerfile: AccountService/Dockerfile }
    depends_on: { eureka-server: { condition: service_healthy }, database-init: {}, redis: {} }
`,
  );
  return root;
}

test('Spring Boot 앱, 포트, 헬스 주소, 실행 명령, 의존성, 인프라를 찾아낸다', () => {
  const root = makeProject();
  const project = detectProject(root, { useDocker: false });
  const apps = Object.fromEntries(project.apps.map((a) => [a.name, a]));
  assert.deepEqual(Object.keys(apps).sort(), ['account-service', 'eureka-server', 'menus']);

  assert.equal(apps['account-service'].port, 7171, '.env 값이 기본값보다 우선한다');
  assert.equal(apps['account-service'].health, 'http://127.0.0.1:9071/actuator/health');
  assert.deepEqual(apps['account-service'].dependsOn, ['eureka-server']);
  assert.equal(apps['account-service'].cmd, './gradlew bootRun');

  assert.equal(apps['eureka-server'].port, 8761);
  assert.equal(apps.menus.port, 7072);
  assert.equal(apps.menus.health, null);
  assert.equal(apps.menus.cmd, './gradlew :apps:menus:bootRun');
  assert.equal(apps.menus.runDir, root);

  assert.deepEqual(project.infra, ['mariadb', 'database-init', 'redis'], 'grafana처럼 앱이 의존하지 않는 컨테이너는 제외');
  assert.equal(project.envFile, '.env');
});

test('생성한 설정은 오류 없이 다시 읽힌다', () => {
  const root = makeProject();
  const text = renderConfig(detectProject(root, { useDocker: false }));
  const config = normalizeConfig(YAML.parse(text), root);
  assert.deepEqual(config.errors, []);
  assert.equal(config.services['account-service'].dir, path.join(root, 'AccountService'));
  assert.deepEqual(config.infra?.services, ['mariadb', 'database-init', 'redis']);
  assert.ok(text.indexOf('eureka-server:') < text.indexOf('account-service:'), '의존성 순서로 정렬');
});

test('Spring 플레이스홀더를 해석한다', () => {
  assert.equal(resolvePlaceholders('${A:1}', {}), '1');
  assert.equal(resolvePlaceholders('${A:1}', { A: '2' }), '2');
  assert.equal(resolvePlaceholders('http://${HOST:localhost}:${PORT}', { PORT: '9' }), 'http://localhost:9');
});

test('Config Server를 Eureka보다 먼저 띄우고, 서로 쓰는 경우의 순환은 만들지 않는다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devfleet-cloud-'));
  const CONFIG_CLIENT = "implementation 'org.springframework.cloud:spring-cloud-starter-config'\n";
  const EUREKA_CLIENT = "implementation 'org.springframework.cloud:spring-cloud-starter-netflix-eureka-client'\n";
  // Config Server는 Eureka에 등록하고, Eureka는 설정을 Config Server에서 받는다.
  write(root, 'config/build.gradle', BOOT + ACTUATOR + "implementation 'spring-cloud-config-server'\n" + EUREKA_CLIENT);
  write(root, 'config/src/main/resources/application.yml', 'server:\n  port: 8888\n');
  write(root, 'registry/build.gradle', BOOT + "implementation 'spring-cloud-starter-netflix-eureka-server'\n");
  write(
    root,
    'registry/src/main/resources/application.yml',
    'server:\n  port: 8761\nspring:\n  config:\n    import: "optional:configserver:http://localhost:8888"\n',
  );
  write(root, 'order/build.gradle', BOOT + CONFIG_CLIENT + EUREKA_CLIENT);
  write(root, 'order/src/main/resources/application.yml', 'server:\n  port: 8081\n');
  // Eureka 클라이언트 의존성은 있지만 설정으로 끈 앱
  write(root, 'legacy/build.gradle', BOOT + EUREKA_CLIENT);
  write(root, 'legacy/src/main/resources/application.yml', 'server:\n  port: 8082\neureka:\n  client:\n    enabled: false\n');

  const project = detectProject(root, { useDocker: false });
  const apps = Object.fromEntries(project.apps.map((a) => [a.name, a]));
  assert.deepEqual(apps.config?.dependsOn, [], 'Eureka → Config 의존이 이미 있으므로 Config → Eureka는 추가하지 않는다');
  assert.deepEqual(apps.registry?.dependsOn, ['config']);
  assert.deepEqual(apps.order?.dependsOn, ['config', 'registry']);
  assert.deepEqual(apps.legacy?.dependsOn, []);
  assert.deepEqual(apps.config?.roles, ['Spring Cloud Config']);
  assert.deepEqual(apps.registry?.roles, ['Eureka']);
  assert.deepEqual(project.warnings, []);

  const text = renderConfig(project);
  assert.match(text, /# Spring Cloud Config server\n {2}config:/);
  const config = normalizeConfig(YAML.parse(text), root);
  assert.deepEqual(config.errors, []);
  assert.ok(text.indexOf('  config:') < text.indexOf('  registry:'));
  assert.ok(text.indexOf('  registry:') < text.indexOf('  order:'));
});

test('Consul은 compose 서비스를 infra로 넣고, 서버를 못 찾은 Nacos는 경고한다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devfleet-infra-'));
  write(root, 'payment/build.gradle', BOOT + "implementation 'org.springframework.cloud:spring-cloud-starter-consul-discovery'\n");
  write(root, 'payment/src/main/resources/application.yml', 'server:\n  port: 8090\n');
  write(root, 'stock/build.gradle', BOOT + "implementation 'com.alibaba.cloud:spring-cloud-starter-alibaba-nacos-discovery'\n");
  write(root, 'stock/src/main/resources/application.yml', 'server:\n  port: 8091\n');
  write(
    root,
    'compose.yaml',
    `services:
  consul: { image: hashicorp/consul:1.19 }
  redis: { image: redis:8 }
  grafana: { image: grafana/grafana }
  payment:
    build: { context: ., dockerfile: payment/Dockerfile }
    depends_on: [redis]
`,
  );

  const project = detectProject(root, { useDocker: false });
  assert.deepEqual(project.infra, ['consul', 'redis']);
  assert.equal(project.warnings.length, 1);
  assert.match(project.warnings[0] ?? '', /Nacos.*stock/);
  const text = renderConfig(project);
  assert.match(text, /# Please check:\n# {3}- Apps use Nacos \(stock\)/);
  assert.deepEqual(normalizeConfig(YAML.parse(text), root).errors, []);
});

test('init --jar: bootRun 대신 jar를 빌드하고 java -jar로 실행하는 설정을 만든다', () => {
  const root = makeProject();
  const project = detectProject(root, { useDocker: false, jar: true });
  const apps = Object.fromEntries(project.apps.map((a) => [a.name, a]));
  assert.deepEqual(apps['account-service'].build, { cmd: './gradlew bootJar', dir: path.join(root, 'AccountService') });
  assert.equal(apps['account-service'].jar, 'build/libs/*.jar');
  assert.equal(apps['account-service'].cmd, '');
  // 멀티 모듈: 루트에서 빌드하고, 앱은 자기 폴더에서 실행한다
  assert.deepEqual(apps.menus.build, { cmd: './gradlew :apps:menus:bootJar', dir: root });
  assert.equal(apps.menus.runDir, path.join(root, 'apps/menus'));

  const text = renderConfig(project);
  assert.match(text, /# Jar mode:/);
  const config = normalizeConfig(YAML.parse(text), root);
  assert.deepEqual(config.errors, []);
  assert.deepEqual(config.services.menus?.build, { cmd: './gradlew :apps:menus:bootJar', dir: root });
  assert.equal(config.services.menus?.dir, path.join(root, 'apps/menus'));
  assert.equal(config.services['account-service']?.jar, 'build/libs/*.jar');
  assert.equal(config.services['account-service']?.cmd, '');
  assert.equal(config.services['account-service']?.javaOpts, '-XX:TieredStopAtLevel=1', 'bootRun과 같은 JIT 설정');
});
