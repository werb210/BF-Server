import type { Deps } from "./deps.js";

export function isReady(deps: Deps): boolean {
  return deps.db.ready === true;
}
