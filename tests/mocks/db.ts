// tests/mocks/db.ts

export const lenders = [
  {
    id: "1",
    name: "Test Lender",
    active: true,
    created_at: new Date(),
  },
];

export const lender_products = [
  {
    id: "1",
    lender_id: "1",
    name: "Test Product",
    min_amount: 10000,
    max_amount: 500000,
    interest_rate: 10,
    created_at: new Date(),
  },
];

export const query = async (sql: string) => {
  if (sql.includes("lender_products")) {
    return {
      rows: lender_products,
    };
  }

  if (sql.includes("lenders")) {
    return {
      rows: lenders,
    };
  }

  if (sql.includes("lender_product_requirements")) {
    return {
      rows: [
        {
          id: 1,
          lender_product_id: 1,
          key: "min_credit_score",
          value: "600",
        },
      ],
    };
  }

  if (sql.includes("users")) {
    return {
      rows: [
        {
          id: 1,
          email: "test@test.com",
          created_at: new Date(),
        },
      ],
    };
  }

  if (sql.includes("voicemails")) {
    return {
      rows: [
        {
          id: 1,
          user_id: 1,
          url: "https://test.com/audio.mp3",
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
