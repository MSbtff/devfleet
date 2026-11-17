/**
 * Spring Cloud 구성 요소 감지 규칙.
 *
 * 규칙 하나는 "어떤 서버가 있고, 어떤 앱이 그 서버를 쓰는가"를 표현한다.
 * 서버를 쓰는 앱은 서버가 준비된 뒤에 시작해야 하므로 `init`이 의존성을 추가한다.
 *
 * - 서버가 같은 프로젝트의 Spring Boot 앱이면 `serves`로 찾는다 (Eureka 서버, Config Server).
 * - 서버가 외부 제품이면 `infraImage`로 compose 서비스를 찾아 infra에 넣는다 (Consul, Nacos).
 *
 * 새 규칙은 RULES 배열에 객체 하나를 추가하면 된다. 배열 순서가 우선순위이며,
 * 앞선 규칙이 만든 의존성과 순환이 생기는 의존성은 추가하지 않는다.
 */

export interface AppFacts {
  /** build.gradle(.kts) 또는 pom.xml 내용 */
  buildText: string;
  /** application.yml/properties의 기본 프로필 값 (평평한 key) */
  props: Record<string, unknown>;
}

export interface DetectorRule {
  id: string;
  /** 사람이 읽는 이름. 경고·주석에 쓴다 */
  label: string;
  /** 이 앱이 서버 역할을 하는지 */
  serves?: (app: AppFacts) => boolean;
  /** 서버 앱이 없을 때 compose 서비스 이름이나 이미지로 서버를 찾는다 */
  infraImage?: RegExp;
  /** 이 앱이 서버를 필요로 하는지 */
  uses: (app: AppFacts) => boolean;
}

const has = (app: AppFacts, pattern: RegExp): boolean => pattern.test(app.buildText);
const isFalse = (value: unknown): boolean => value === false || value === 'false';
const prop = (app: AppFacts, key: string): string => String(app.props[key] ?? '');

export const RULES: readonly DetectorRule[] = [
  {
    id: 'config',
    label: 'Spring Cloud Config',
    serves: (app) => has(app, /spring-cloud-config-server/),
    infraImage: /config-server/,
    uses: (app) =>
      prop(app, 'spring.config.import').includes('configserver:') ||
      (has(app, /spring-cloud-starter-config\b/) && !isFalse(app.props['spring.cloud.config.enabled'])),
  },
  {
    id: 'eureka',
    label: 'Eureka',
    serves: (app) => has(app, /eureka-server/),
    infraImage: /eureka/,
    uses: (app) =>
      has(app, /eureka-client|spring-cloud-starter-gateway/) && !isFalse(app.props['eureka.client.enabled']),
  },
  {
    id: 'consul',
    label: 'Consul',
    infraImage: /(^|[/_-])consul\b/,
    uses: (app) => has(app, /spring-cloud-starter-consul/) && !isFalse(app.props['spring.cloud.consul.enabled']),
  },
  {
    id: 'nacos',
    label: 'Nacos',
    infraImage: /nacos/,
    uses: (app) => has(app, /nacos-(discovery|config)/),
  },
];
