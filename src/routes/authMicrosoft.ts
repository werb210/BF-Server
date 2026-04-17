import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { AppError } from "../middleware/errors.js";
import { dbQuery } from "../db.js";

const router = Router();
router.use(requireAuth);

router.post(
  "/microsoft",
  safeHandler(async (req: any, res: any) => {
    const { accessToken, accountEmail } = req.body as {
      accessToken?: string;
      accountEmail?: string;
    };

    if (!accessToken) {
      throw new AppError("validation_error", "accessToken is required.", 400);
    }

    const graphRes = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!graphRes.ok) {
      throw new AppError("invalid_token", "Microsoft access token is invalid.", 401);
    }

    const profile = (await graphRes.json()) as { mail?: string; userPrincipalName?: string };
    const email = profile.mail ?? profile.userPrincipalName ?? accountEmail ?? "";

    await dbQuery(
      `UPDATE users
          SET o365_user_email = $1,
              o365_access_token = $2,
              o365_token_expires_at = now() + interval '1 hour'
        WHERE id = $3`,
      [email, accessToken, req.user!.userId]
    );

    res.status(200).json({ ok: true, email, connected: true });
  })
);

export default router;
