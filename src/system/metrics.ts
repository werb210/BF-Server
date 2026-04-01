const counters = {
  requests: 0,
  errors: 0,
};

export function incReq(): void {
  counters.requests += 1;
}

export function incErr(): void {
  counters.errors += 1;
}

export function metrics() {
  return { ...counters };
}

export function resetMetrics(): void {
  counters.requests = 0;
  counters.errors = 0;
}
