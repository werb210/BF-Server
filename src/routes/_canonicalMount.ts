import { Router } from "express";

// BF_SERVER_BLOCK_v682_MOUNT_GUARD_NONFATAL_v1
// A duplicate mount path used to throw ("ROUTE COLLISION: /maya already
// mounted"), which crashes the entire server on boot and crash-loops it —
// the same class of boot-time outage as the migration-lock deadlock (v681).
// A duplicated or misordered route-registry entry must never take prod down.
// Now: log loudly and SKIP the duplicate, keeping the FIRST registration, so
// the server boots and serves. The warning names the colliding path so the
// redundant entry can be found and removed deliberately — not under a
// production outage.
export function createMountTracker() {
  const mounted = new Set<string>();

  return function mount(router: Router, path: string, handler: Router) {
    if (mounted.has(path)) {
      console.error(
        `[ROUTES] duplicate mount for "${path}" ignored (first registration kept). ` +
        `Remove the redundant route-registry entry for "${path}".`
      );
      return;
    }

    mounted.add(path);
    router.use(path, handler);
  };
}
