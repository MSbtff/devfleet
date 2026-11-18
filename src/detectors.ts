/**
 * Detection rules for Spring Cloud components.
 *
 * A rule describes "which server exists, and which apps use it".
 * Apps that use a server must start after it is ready, so `init` adds that dependency.
 *
 * - When the server is a Spring Boot app in the same project, `serves` finds it (Eureka server, Config Server).
 * - When the server is an external product, `infraImage` finds its compose service and adds it to infra (Consul, Nacos).
 *
 * To add a rule, append one object to RULES. Array order is priority order, and a dependency
 * that would form a cycle with one added by an earlier rule is skipped.
 */

export interface AppFacts {
  /** Contents of build.gradle(.kts) or pom.xml */
  buildText: string;
  /** Default-profile values from application.yml/properties (flattened keys) */
  props: Record<string, unknown>;
}

export interface DetectorRule {
  id: string;
  /** Human-readable name, used in warnings and comments */
  label: string;
  /** Whether this app is the server */
  serves?: (app: AppFacts) => boolean;
  /** Finds the server by compose service name or image when no app provides it */
  infraImage?: RegExp;
  /** Whether this app needs the server */
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
