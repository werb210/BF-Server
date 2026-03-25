// no jest dependency → pure stub
export const mockTwilio = {
  messages: {
    create: async () => ({ sid: "mock-sid" }),
  },
};
