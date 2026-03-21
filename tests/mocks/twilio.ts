export const client = {
  verify: {
    services: () => ({
      verifications: {
        create: async () => ({ sid: 'test' }),
      },
      verificationChecks: {
        create: async () => ({ status: 'approved' }),
      },
    }),
  },
};
