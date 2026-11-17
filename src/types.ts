/** 서비스가 준비됐는지 판단하는 방법 */
export type Health =
  | { type: 'http'; url: string; timeout: number; interval: number }
  | { type: 'tcp'; port: number; timeout: number; interval: number }
  | { type: 'none'; timeout: number; interval: number };

export interface Service {
  name: string;
  /** 명령을 실행할 절대 경로 */
  dir: string;
  cmd: string;
  env: Record<string, string>;
  envFile: string | null;
  dependsOn: string[];
  port: number | null;
  health: Health;
  /** Ctrl+C 후 정상 종료를 기다릴 초 */
  stopTimeout: number;
}

export interface Infra {
  composeFiles: string[];
  services: string[];
  stopOnExit: boolean;
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
  errors: string[];
}

/** 의존성 그래프 계산에 필요한 최소 정보 */
export type DependencyMap = Record<string, { dependsOn: string[] }>;

export type RawRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
