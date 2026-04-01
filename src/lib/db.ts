export const db: any = {
  query: async (..._args: any[]) => {
    return { rows: [], rowCount: 0 };
  },
};

export const queryDb: any = {
  query: db.query,
};

export const getPrisma = (): any => {
  return {};
};
