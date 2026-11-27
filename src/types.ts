export type Health =
  | { type: 'http'; url: string; timeout: number; interval: number }
  | { type: 'tcp'; port: number; timeout: number; interval: number }
  | { type: 'none'; timeout: number; interval: number };

export interface Build {
  cmd: string;
  dir: string;
}

export interface Service {
  name: string;
  dir: string;
  cmd: string;
  build: Build | null;
  jar: string | null;
  javaOpts: string;
  env: Record<string, string>;
  envFile: string | null;
  dependsOn: string[];
  port: number | null;
  health: Health;
  stopTimeout: number;
  restart: RestartPolicy;
  maxRestarts: number;
}

export type GradleDaemonPolicy = 'stop' | 'keep';

export type RestartPolicy = 'no' | 'on-failure';

export interface Infra {
  composeFiles: string[];
  services: string[];
  stopOnExit: boolean;
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
  buildConcurrency: number;
  gradleDaemon: GradleDaemonPolicy;
  errors: string[];
}

export type DependencyMap = Record<string, { dependsOn: string[] }>;

export type RawRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
