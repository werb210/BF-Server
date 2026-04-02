import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { stripUndefined } from "../utils/clean";

const router = Router();

type Issue = {
  id: string;
  message: string;
  screenshot?: string;
  createdAt: Date;
  resolved: boolean;
};

const issues: Issue[] = [];
const MAX_ISSUES = 500;

function pushBounded<T>(arr: T[], item: T): void {
  arr.push(item);
  if (arr.length > MAX_ISSUES) arr.shift();
}

const createIssueSchema = z.object({
  message: z.string().min(1),
  screenshot: z.string().optional(),
});

router.post("/", async (req: any, res: any, next: any) => {
  const parsed = createIssueSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload" });
    return;
  }

  const issue: Issue = stripUndefined({
    id: uuidv4(),
    message: parsed.data.message,
    screenshot: parsed.data.screenshot,
    createdAt: new Date(),
    resolved: false,
  }) as Issue;

  pushBounded(issues, issue);

  res["json"]({ success: true, id: issue.id });
});

router.patch("/:id/resolve", (req: any, res: any) => {
  const issue = issues.find((entry) => entry.id === req.params.id);
  if (issue) issue.resolved = true;
  res["json"]({ success: true });
});

export default router;
