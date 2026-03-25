import { Router } from "express";

const router = Router();

router.post("/upload", (req, res) => {
  res.json({
    ok: true,
    data: { id: "doc-1", status: "uploaded" },
  });
});

export default router;
