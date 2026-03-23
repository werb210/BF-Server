import { Router } from "express";

const router = Router();

type SessionRequest = {
  session?: {
    user?: unknown;
    [key: string]: unknown;
  };
};

router.get("/session", async (req: any, res: any, next: any) => {
  const sessionUser = (req as unknown as SessionRequest).session?.user;

  if (sessionUser) {
    return res.json({
      authenticated: true,
      user: sessionUser,
    });
  }

  return res.json({
    authenticated: false,
  });
});

router.post("/api/client/session/refresh", async (req: any, res: any, next: any) => {
  const session = (req as unknown as SessionRequest).session;

  if (!session) {
    return res.status(401).json({ error: "No session" });
  }

  return res.json({
    success: true,
    session,
  });
});

export default router;
