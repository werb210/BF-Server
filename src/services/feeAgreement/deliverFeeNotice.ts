// BF_SERVER_FEE_NOTICE_DELIVERY_v740
// Tells the applicant there is a fee agreement to sign. It used to be push OR text: when
// Apple accepted a push the text was skipped, even though an accepted push is not a shown
// one, and a file with no usable mobile returned quietly while the portal said "Sent".
// Now: app notice (if the app is installed) AND a text AND an email, each checked. Every
// channel is recorded in client_notifications. If nothing went out it throws, so staff see
// the reason instead of "Sent".
export type FeeDelivery = { push: boolean; sms: boolean; email: boolean; phoneLast4: string | null; emailTo: string | null; errors: string[] };
type Notice = { phone: string; applicationId: string; kind: string; sms: string; title: string; body: string; categoryId?: any };
export type FeeDeliveryDeps = {
  pushApp: (n: Notice) => Promise<boolean>;
  sms: (phone: string, text: string, track: { kind: string; applicationId: string }) => Promise<any>;
  emailReady: () => boolean;
  email: (to: string, subject: string, html: string) => Promise<{ ok: boolean; error?: string }>;
  record: (applicationId: string, phone10: string, channel: string, error: string | null) => Promise<void>;
};
export const FEE_NOTICE_KIND = "media_fee_agreement";
const digits10 = (p: string): string => String(p ?? "").replace(/[^0-9]/g, "").slice(-10);

export async function deliverFeeNotice(input: { applicationId: string; phone: string | null; email: string | null; firstName: string | null }, deps: FeeDeliveryDeps = defaultDeps): Promise<FeeDelivery> {
  const hi = input.firstName ? "Hi " + input.firstName + "," : "Hi,";
  const out: FeeDelivery = { push: false, sms: false, email: false, phoneLast4: null, emailTo: null, errors: [] };
  const phone10 = input.phone ? digits10(input.phone) : "";
  if (phone10.length === 10 && input.phone) {
    out.phoneLast4 = phone10.slice(-4);
    const smsText = hi + " Boreal Financial has a fee agreement for you to sign. Sign in at client.boreal.financial with this phone number to review and sign. Reply STOP to opt out.";
    try {
      out.push = await deps.pushApp({ phone: input.phone, applicationId: input.applicationId, kind: FEE_NOTICE_KIND, sms: smsText, title: "Fee agreement to sign", body: "Please review and sign your fee agreement.", categoryId: "APPLICATION_UPDATE" });
    } catch (err: any) {
      out.errors.push("app: " + String(err?.message ?? err));
    }
    let smsError: string | null = null;
    try {
      const r = await deps.sms(input.phone, smsText, { kind: FEE_NOTICE_KIND, applicationId: input.applicationId });
      if (r && typeof r.sid === "string" && r.sid) out.sms = true;
      else smsError = "text not sent (server is in TEST_MODE or Twilio returned no message id)";
    } catch (err: any) {
      smsError = "text failed: " + String(err?.message ?? err);
    }
    if (smsError) out.errors.push(smsError);
    await deps.record(input.applicationId, phone10, out.sms ? "sms" : "none", smsError);
  } else {
    out.errors.push("no usable mobile number on the application");
  }
  if (input.email) {
    if (!deps.emailReady()) {
      out.errors.push("email not configured on the server (SendGrid)");
    } else {
      const html = "<p>" + hi + "</p><p>Boreal Financial has a fee agreement (2% on funding) for you to review and sign.</p>"
        + "<p>Sign in at <a href='https://client.boreal.financial'>client.boreal.financial</a> with your mobile number, then open <b>Sign your fee agreement</b>.</p>"
        + "<p>Questions? Call (866) 631-8939.</p>";
      const r = await deps.email(input.email, "Your Boreal Financial fee agreement is ready to sign", html);
      if (r.ok) { out.email = true; out.emailTo = input.email; }
      else out.errors.push("email failed: " + String(r.error ?? "unknown"));
      await deps.record(input.applicationId, phone10 || "0000000000", r.ok ? "email" : "none", r.ok ? null : "email: " + String(r.error ?? "unknown"));
    }
  } else {
    out.errors.push("no email on the application");
  }
  if (!out.push && !out.sms && !out.email) throw new Error(out.errors.join("; ") || "nothing could be sent");
  return out;
}

const defaultDeps: FeeDeliveryDeps = {
  async pushApp(n) {
    const { pushToClientApp } = await import("../notifications/notifyClient.js");
    return pushToClientApp(n as any);
  },
  async sms(phone, text, track) {
    const { sendSms } = await import("../../modules/notifications/sms.service.js");
    return sendSms({ to: phone, message: text, track } as any);
  },
  emailReady() {
    return Boolean(process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM);
  },
  async email(to, subject, html) {
    const { sendTransactional } = await import("../sendgridService.js");
    return sendTransactional({ to, subject, html, customArgs: { kind: FEE_NOTICE_KIND } });
  },
  async record(applicationId, phone10, channel, error) {
    try {
      const { pool } = await import("../../db.js");
      await pool.query("INSERT INTO client_notifications (application_id, phone10, kind, channel, error) VALUES ($1, $2, $3, $4, $5)", [applicationId, phone10, FEE_NOTICE_KIND, channel, error]);
    } catch (err: any) {
      console.warn("[fee-notice] record_failed", { applicationId, message: String(err?.message ?? err) });
    }
  },
};
