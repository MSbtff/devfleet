import type { DependencyMap } from './types.ts';

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
  if (unknown.length) throw new Error(`Unknown service or group: ${unknown.join(', ')}`);
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
