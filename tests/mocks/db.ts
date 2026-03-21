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

  if (sql.includes('lender_product_requirements')) {
    return {
      rows: [
        {
          id: 1,
          lender_product_id: 1,
          key: 'min_credit_score',
          value: '600',
        },
      ],
    };
  }

  if (sql.includes('users')) {
    return {
      rows: [
        {
          id: 1,
          email: 'test@test.com',
          created_at: new Date(),
        },
      ],
    };
  }

  if (sql.includes('voicemails')) {
    return {
      rows: [
        {
          id: 1,
          user_id: 1,
          url: 'https://test.com/audio.mp3',
          created_at: new Date(),
        },
      ],
    };
  }

  // fallback to avoid hard failures
  return { rows: [] };
};

export const db = {
  query,
  insert: async () => ({}),
  update: async () => ({}),
  delete: async () => ({}),
};
