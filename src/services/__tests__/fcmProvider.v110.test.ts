// BF_SERVER_FCM_DELIVERY_v1
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FcmError,
  __setFcmProvider,
  initializeFcmProvider,
  isFcmConfigured,
} from "../fcmProvider.js";

const ENV_KEY = "FIREBASE_SERVICE_ACCOUNT_JSON";

describe("FCM configuration", () => {
  beforeEach(() => { __setFcmProvider(null); delete process.env[ENV_KEY]; });
  afterEach(() => { __setFcmProvider(null); delete process.env[ENV_KEY]; });

  it("stays unconfigured with no service account", () => {
    expect(initializeFcmProvider({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isFcmConfigured()).toBe(false);
  });

  it("stays unconfigured when the service account is not JSON", () => {
    expect(initializeFcmProvider({
      NODE_ENV: "production", [ENV_KEY]: "not json",
    } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("stays unconfigured when the service account is missing fields", () => {
    expect(initializeFcmProvider({
      NODE_ENV: "production", [ENV_KEY]: JSON.stringify({ project_id: "p" }),
    } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("configures from a complete service account", () => {
    const account = JSON.stringify({
      project_id: "financial-ed1cf",
      client_email: "svc@financial-ed1cf.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----\\n",
    });
    expect(initializeFcmProvider({
      NODE_ENV: "production", [ENV_KEY]: account,
    } as NodeJS.ProcessEnv)).toBe(true);
    expect(isFcmConfigured()).toBe(true);
  });

  it("never configures under NODE_ENV=test", () => {
    const account = JSON.stringify({ project_id: "p", client_email: "e", private_key: "k" });
    expect(initializeFcmProvider({
      NODE_ENV: "test", [ENV_KEY]: account,
    } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("FCM error classification", () => {
  it("retains whether a failure permanently invalidates a registration", () => {
    expect(new FcmError("fcm_send_failed_404:", true).invalidRegistration).toBe(true);
    expect(new FcmError("fcm_send_failed_500:", false).invalidRegistration).toBe(false);
  });
});
