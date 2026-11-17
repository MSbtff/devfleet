/** 순환 의존성이 있으면 경로를, 없으면 null을 돌려준다. */
export function findCycle(services) {
  const state = new Map(); // undefined: 미방문, 1: 방문 중, 2: 완료
  const stack = [];
  const visit = (name) => {
    state.set(name, 1);
    stack.push(name);
    for (const dep of services[name]?.dependsOn ?? []) {
      if (!services[dep]) continue;
      if (state.get(dep) === 1) return [...stack.slice(stack.indexOf(dep)), dep];
      if (!state.get(dep)) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(name, 2);
    return null;
  };
  for (const name of Object.keys(services)) {
    if (!state.get(name)) {
      const found = visit(name);
      if (found) return found;
    }
  }
  return null;
}

/** 이름(서비스 또는 그룹) 목록을 실제 실행할 서비스 목록으로 바꾼다. 설정 파일 순서를 유지한다. */
export function resolveTargets(config, names = [], { withDeps = true } = {}) {
  const selected = new Set();
  const unknown = [];
  for (const name of names) {
    if (config.groups[name]) config.groups[name].forEach((n) => selected.add(n));
    else if (config.services[name]) selected.add(name);
    else unknown.push(name);
  }
  if (unknown.length) {
    throw new Error(`알 수 없는 서비스 또는 그룹: ${unknown.join(', ')}`);
  }
  if (!names.length) Object.keys(config.services).forEach((n) => selected.add(n));
  if (withDeps) {
    const stack = [...selected];
    while (stack.length) {
      for (const dep of config.services[stack.pop()].dependsOn) {
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
export function waves(services, names) {
  const set = new Set(names);
  const level = new Map();
  const depth = (name) => {
    if (level.has(name)) return level.get(name);
    const deps = services[name].dependsOn.filter((d) => set.has(d));
    const value = deps.length ? Math.max(...deps.map(depth)) + 1 : 0;
    level.set(name, value);
    return value;
  };
  const result = [];
  for (const name of names) (result[depth(name)] ??= []).push(name);
  return result.filter(Boolean);
}
