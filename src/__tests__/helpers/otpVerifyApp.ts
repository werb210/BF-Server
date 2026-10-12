// BF_SERVER_v789_SG6 - shared harness for behaviour tests of routes/auth.ts OTP handlers.
// The test file owns the vi.mock declarations (they must be hoisted there); this module
// only mounts the real router and builds the fake Twilio client the mocks hand back.
//
// Typical mock set in a test file under src/__tests__/:
//   vi.mock("../config/runtime.js", () => ({ isTest: false }));           // the production branches
//   vi.mock("../middleware/authRateLimit.js", () => passthroughLimiters());
//   vi.mock("../lib/sharedClients.js", () => ({ sharedTwilio: () => fakeSharedTwilio(h), sharedOpenAI: () => ({}) }));
//   vi.mock("../lib/db.js", ...runQuery: h.query), vi.mock("../db.js", ...pool.query: h.query)
//   vi.mock("../modules/auth/auth.repo.js", ...findAuthUserByPhone: h.findAuthUserByPhone)
import express from "express";

type AnyFn = (...args: any[]) => any;

/** What sharedTwilio() returns in these tests: Verify only, dispatching to the given mocks. */
export function fakeSharedTwilio(m: { verificationCheck: AnyFn; verificationCreate: AnyFn }) {
  return {
    verify: {
      v2: {
        services: (_sid: string) => ({
          verifications: { create: (p: unknown) => m.verificationCreate(p) },
          verificationChecks: { create: (p: unknown) => m.verificationCheck(p) },
        }),
      },
    },
  };
}

const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();

/** The OTP rate limiters as no-ops (they would otherwise count every test request). */
export function passthroughLimiters() {
  return { otpStartLimiter: passthrough, otpVerifyLimiter: passthrough };
}

export async function otpApp() {
  const router = (await import("../../routes/auth.js")).default;
  const app = express();
  app.use(express.json());
  app.use("/api/auth", router);
  return app;
}
