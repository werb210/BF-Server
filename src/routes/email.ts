import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { ROLES } from "../auth/roles.js";
import { AppError } from "../middleware/errors.js";
import { dbQuery } from "../db.js";
import { logCrmEvent } from "../modules/crm/crmTimeline.service.js";

const router = Router();
router.use(requireAuth);
router.use(requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }));

const sendEmailSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string().min(1),
  fromInbox: z.enum(["personal", "shared"]),
  crmContactId: z.string().uuid().optional(),
  applicationId: z.string().uuid().optional(),
});

router.post(
  "/send",
  safeHandler(async (req: any, res: any) => {
    const parsed = sendEmailSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError("validation_error", "Invalid email payload.", 400);
    }

    const { to, subject, body, fromInbox, crmContactId, applicationId } = parsed.data;

    // v631: route through getGraphForUser so expired access tokens are
    // transparently refreshed via stored refresh token (delegated flow).
    const { pool } = await import("../db.js");
    const { getGraphForUser } = await import("../modules/o365/graphClient.js");
    const graph = await getGraphForUser(pool, req.user!.userId);
    if (!graph) {
      throw new AppError("not_configured", "Connect Microsoft 365 in Settings → My Profile to send email.", 422);
    }

    const meResp = await graph.fetch("/me?$select=mail,userPrincipalName");
    const meJson = await meResp.json() as { mail?: string; userPrincipalName?: string };
    const personalEmail = (meJson.mail ?? meJson.userPrincipalName ?? "").trim();
    const sharedEmail = process.env.O365_SHARED_INBOX_EMAIL ?? "";
    const senderEmail = fromInbox === "shared" ? sharedEmail : personalEmail;
    if (!senderEmail) {
      throw new AppError("not_configured", "Sender inbox is not configured.", 422);
    }

    const endpoint = fromInbox === "shared"
      ? `/users/${encodeURIComponent(senderEmail)}/sendMail`
      : "/me/sendMail";

    const response = await graph.fetch(endpoint, {
      method: "POST",
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: "HTML", content: body },
          toRecipients: [{ emailAddress: { address: to } }],
        },
        saveToSentItems: true,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new AppError("email_send_failed", `Graph send failed (${response.status}): ${detail.slice(0, 300)}`, 502);
    }

    if (crmContactId) {
      await logCrmEvent({
        contactId: crmContactId,
        applicationId: applicationId ?? null,
        eventType: "email_sent",
        payload: { to, subject, fromInbox, senderEmail },
        actorUserId: req.user?.userId,
      });
    }

    res.status(200).json({ ok: true });
  })
);

export default router;
