// tests/mocks/db.ts

export const query = async (sql: string) => {
  if (sql.includes('lender_products')) {
    return {
      rows: [
        {
          id: 1,
          lender_id: 1,
          name: 'Test Product',
          category: 'loan',
          min_amount: 1000,
          max_amount: 5000,
          created_at: new Date(),
        },
      ],
    };
  }

  if (sql.includes('lenders')) {
    return {
      rows: [
        {
          id: 1,
          name: 'Test Lender',
          created_at: new Date(),
        },
      ],
    };
  }

  return { rows: [] };
};

export const db = {
  query,
  insert: async () => ({}),
  update: async () => ({}),
  delete: async () => ({}),
};
