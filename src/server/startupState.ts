type StartupStatus = {
  ready: boolean;
  reason: string | null;
  startedAt: number;
};

const state: StartupStatus = {
  ready: false,
  reason: "starting",
  startedAt: Date.now(),
};

export function markReady(): void {
  state.ready = true;
  state.reason = null;
}

export function markNotReady(reason: string): void {
  state.ready = false;
  state.reason = reason;
}

export function isReady(): boolean {
  return state.ready;
}

export function fetchStatus(): StartupStatus {
  return { ...state };
}

export function resetStartupState(): void {
  state.ready = false;
  state.reason = "starting";
  state.startedAt = Date.now();
}
