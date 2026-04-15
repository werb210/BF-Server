import { Router } from "express";

export function createMountTracker() {
  const mounted = new Set<string>();

  return function mount(router: Router, path: string, handler: Router) {
    if (mounted.has(path)) {
      throw new Error(`ROUTE COLLISION: ${path} already mounted`);
    }

    mounted.add(path);
    router.use(path, handler);
  };
}
