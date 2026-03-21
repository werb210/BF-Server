import { vi } from "vitest";

export default function () {
  return {
    verify: {
      services: () => ({
        verifications: {
          create: vi.fn(),
        },
        verificationChecks: {
          create: vi.fn(),
        },
      }),
    },
  };
}
