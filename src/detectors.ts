export interface AppFacts {
  buildText: string;
  props: Record<string, unknown>;
}

export interface DetectorRule {
  id: string;
  label: string;
  serves?: (app: AppFacts) => boolean;
  infraImage?: RegExp;
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
