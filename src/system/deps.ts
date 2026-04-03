export const deps = {
  db: {
    ready: false,
    client: null as any,
  },
  metrics: {
    requests: 0,
    errors: 0,
  },
};

export type Deps = typeof deps;
