// BF_SERVER_FCM_DATA_ONLY_v157
// Builds the FCM message body for an Android push.
//
// Why this exists: the previous body carried a `notification` block. FCM renders
// those itself in the system tray, which means the app is never handed the
// message while backgrounded - so it cannot draw action buttons, and the
// categories v126 stamps have nothing to act on. Android action buttons require
// a data-only message that the app's own FirebaseMessagingService renders.
//
// Title and body therefore move into `data`, where the client reads them back.

export type FcmPayload = {
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

export type FcmMessage = {
  message: {
    token: string;
    data: Record<string, string>;
    android: {
      priority: "high";
      /** No `notification` block: that is what forced tray rendering. */
      ttl?: string;
    };
  };
};

/** FCM data values must be strings; anything else is serialised. */
export function toDataStrings(input: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return out;
}

/**
 * Data-only, so the client renders the notification and can attach the action
 * buttons for the stamped category.
 */
export function buildFcmMessage(token: string, payload: FcmPayload): FcmMessage {
  const data = toDataStrings(payload.data);
  // The client reads these back out to draw the notification itself.
  data.title = String(payload.title ?? "");
  data.body = String(payload.body ?? "");
  if (!data.categoryId) data.categoryId = "GENERIC";

  return {
    message: {
      token,
      data,
      android: { priority: "high" },
    },
  };
}
