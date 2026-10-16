// BF_SERVER_PUSH_CONFIG_DIAG_v153
// Reports which push transports are configured and, when one is not, exactly
// which environment variable names are missing.
//
// The startup log says only `client_apns_not_configured` / `fcm_not_configured`,
// which is true but not actionable - the applicant APNs path needs four
// variables, three of which are shared with Watch push, so "not configured"
// could mean any one of them. Names only: a value is never read back out.

export type TransportStatus = {
  transport: "client_apns" | "watch_apns" | "fcm";
  configured: boolean;
  /** Variable names that are absent or blank. Never their values. */
  missing: string[];
  note?: string;
};

function blank(env: NodeJS.ProcessEnv, name: string): boolean {
  return !String(env[name] ?? "").trim();
}

function statusFor(
  transport: TransportStatus["transport"],
  env: NodeJS.ProcessEnv,
  required: string[],
  note?: string,
): TransportStatus {
  const missing = required.filter((name) => blank(env, name));
  return { transport, configured: missing.length === 0, missing, ...(note ? { note } : {}) };
}

export const CLIENT_APNS_VARS = [
  "WATCH_APNS_TEAM_ID",
  "WATCH_APNS_KEY_ID",
  "WATCH_APNS_PRIVATE_KEY",
  "CLIENT_APNS_BUNDLE_ID_BF",
];

export const WATCH_APNS_VARS = [
  "WATCH_APNS_TEAM_ID",
  "WATCH_APNS_KEY_ID",
  "WATCH_APNS_PRIVATE_KEY",
  "WATCH_APNS_BUNDLE_ID",
];

export const FCM_VARS = ["FIREBASE_SERVICE_ACCOUNT_JSON"];

// BF_SERVER_v817_CLIENT - the env the client APNs path effectively reads (own value, else the Watch one).
function clientApnsEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const part of ["TEAM_ID", "KEY_ID", "PRIVATE_KEY"]) {
    const own = String(env["CLIENT_APNS_" + part] ?? "").trim();
    if (own) out["WATCH_APNS_" + part] = own;
  }
  return out;
}

export function pushConfigReport(env: NodeJS.ProcessEnv = process.env) {
  const transports = [
    // BF_SERVER_v817_CLIENT - CLIENT_APNS_TEAM_ID / _KEY_ID / _PRIVATE_KEY override the shared WATCH_APNS_* values.
    statusFor("client_apns", clientApnsEnv(env), CLIENT_APNS_VARS,
      "applicant iOS push; CLIENT_APNS_TEAM_ID/_KEY_ID/_PRIVATE_KEY, else the shared WATCH_APNS_* values"),
    statusFor("watch_apns", env, WATCH_APNS_VARS, "Apple Watch push"),
    statusFor("fcm", env, FCM_VARS, "Android push for both client apps"),
  ];

  // Shared credentials mean one missing value can look like several broken
  // transports. Naming the overlap stops that being chased three times.
  const sharedMissing = CLIENT_APNS_VARS.filter(
    (name) => WATCH_APNS_VARS.includes(name) && blank(env, name),
  );

  return {
    anyConfigured: transports.some((t) => t.configured),
    transports,
    sharedMissing,
    /** Optional: the BI client app has its own bundle id. */
    optional: {
      CLIENT_APNS_BUNDLE_ID_BI: !blank(env, "CLIENT_APNS_BUNDLE_ID_BI"),
    },
  };
}

/** One-line summary for the startup log. */
export function pushConfigSummary(env: NodeJS.ProcessEnv = process.env): string {
  const report = pushConfigReport(env);
  const parts = report.transports.map(
    (t) => `${t.transport}=${t.configured ? "ok" : "missing[" + t.missing.join(",") + "]"}`,
  );
  return parts.join(" ");
}
