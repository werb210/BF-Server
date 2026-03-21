// tests/mocks/db.ts

export const db = {
  query: async () => ({
    rows: [
      {
        id: 1,
        lender_id: 1,
        name: 'test',
        category: 'test',
        min_amount: 1000,
        max_amount: 5000,
        created_at: new Date(),
      },
    ],
  }),
  insert: async () => ({}),
  update: async () => ({}),
  delete: async () => ({}),
};
