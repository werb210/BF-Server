import { type Router } from "express";

const mounted = new Set<string>();

export function resetMountedRoutes(): void {
  mounted.clear();
}

export function mount(router: Router, path: string, handler: Router): void {
  if (mounted.has(path)) {
    throw new Error(`ROUTE COLLISION: ${path} already mounted`);
  }

  mounted.add(path);
  router.use(path, handler);
}
