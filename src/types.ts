/** How to tell that a service is ready */
export type Health =
  | { type: 'http'; url: string; timeout: number; interval: number }
  | { type: 'tcp'; port: number; timeout: number; interval: number }
  | { type: 'none'; timeout: number; interval: number };

export interface Build {
  /** Shell command that builds the service, such as ./gradlew bootJar */
  cmd: string;
  /** Absolute working directory for the build */
  dir: string;
}

export interface Service {
  name: string;
  /** Absolute working directory for the command */
  dir: string;
  /** Shell command that runs the service. Empty when `jar` is set. */
  cmd: string;
  /** Runs before the service starts (and again on `devfleet restart`) */
  build: Build | null;
  /** Jar to run with java -jar, relative to dir. `*` may appear in the file name. */
  jar: string | null;
  /** Options placed before -jar, such as -Xmx512m */
  javaOpts: string;
  env: Record<string, string>;
  envFile: string | null;
  dependsOn: string[];
  port: number | null;
  health: Health;
  /** Seconds to wait for a clean exit after Ctrl+C */
  stopTimeout: number;
  /** Whether to start the service again when it exits on its own after becoming ready */
  restart: RestartPolicy;
  /** Automatic restarts allowed in a row before giving up */
  maxRestarts: number;
}

export type RestartPolicy = 'no' | 'on-failure';

export interface Infra {
  composeFiles: string[];
  services: string[];
  stopOnExit: boolean;
  /** Seconds to wait for the infra to become ready */
  timeout: number;
}

export interface Config {
  root: string;
  file?: string;
  envFile: string | null;
  env: Record<string, string>;
  services: Record<string, Service>;
  groups: Record<string, string[]>;
  infra: Infra | null;
  logDir: string;
  /** How many builds may run at the same time */
  buildConcurrency: number;
  errors: string[];
}

/** The minimum needed to compute the dependency graph */
export type DependencyMap = Record<string, { dependsOn: string[] }>;

export type RawRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
