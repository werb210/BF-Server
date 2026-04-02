export type Deps = {
  db: {
    ready: boolean;
    error: unknown;
  };
};

export const deps: Deps = {
  db: {
    ready: false,
    error: null,
  },
};
