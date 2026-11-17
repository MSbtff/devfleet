import type { DependencyMap } from './types.ts';

/** 순환 의존성이 있으면 경로를, 없으면 null을 돌려준다. */
export function findCycle(services: DependencyMap): string[] | null {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (name: string): string[] | null => {
    state.set(name, 'visiting');
    stack.push(name);
    for (const dep of services[name]?.dependsOn ?? []) {
      if (!services[dep]) continue;
      if (state.get(dep) === 'visiting') return [...stack.slice(stack.indexOf(dep)), dep];
      if (!state.has(dep)) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(name, 'done');
    return null;
  };
  for (const name of Object.keys(services)) {
    if (!state.has(name)) {
      const found = visit(name);
      if (found) return found;
    }
  }
  return null;
}

interface TargetSource {
  services: DependencyMap;
  groups: Record<string, string[]>;
}

/** 이름(서비스 또는 그룹) 목록을 실제 실행할 서비스 목록으로 바꾼다. 설정 파일 순서를 유지한다. */
export function resolveTargets(
  config: TargetSource,
  names: readonly string[] = [],
  { withDeps = true }: { withDeps?: boolean } = {},
): string[] {
  const selected = new Set<string>();
  const unknown: string[] = [];
  for (const name of names) {
    const group = config.groups[name];
    if (group) group.forEach((n) => selected.add(n));
    else if (config.services[name]) selected.add(name);
    else unknown.push(name);
  }
  if (unknown.length) throw new Error(`알 수 없는 서비스 또는 그룹: ${unknown.join(', ')}`);
  if (!names.length) Object.keys(config.services).forEach((n) => selected.add(n));
  if (withDeps) {
    const stack = [...selected];
    let name: string | undefined;
    while ((name = stack.pop()) !== undefined) {
      for (const dep of config.services[name]?.dependsOn ?? []) {
        if (!selected.has(dep)) {
          selected.add(dep);
          stack.push(dep);
        }
      }
    }
  }
  return Object.keys(config.services).filter((n) => selected.has(n));
}

/** 의존성 깊이별로 묶는다. 같은 단계의 서비스는 동시에 시작할 수 있다. */
export function waves(services: DependencyMap, names: readonly string[]): string[][] {
  const set = new Set(names);
  const level = new Map<string, number>();
  const depth = (name: string): number => {
    const known = level.get(name);
    if (known !== undefined) return known;
    const deps = (services[name]?.dependsOn ?? []).filter((d) => set.has(d));
    const value = deps.length ? Math.max(...deps.map(depth)) + 1 : 0;
    level.set(name, value);
    return value;
  };
  const result: string[][] = [];
  for (const name of names) (result[depth(name)] ??= []).push(name);
  return result.filter(Boolean);
}
