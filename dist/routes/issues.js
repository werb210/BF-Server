import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { stripUndefined } from "../utils/clean.js";
const router = Router();
const issues = [];
const MAX_ISSUES = 500;
function pushBounded(arr, item) {
    arr.push(item);
    if (arr.length > MAX_ISSUES)
        arr.shift();
}
const createIssueSchema = z.object({
    message: z.string().min(1),
    screenshot: z.string().optional(),
});
router.post("/", async (req, res, next) => {
    const parsed = createIssueSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "Invalid payload" });
        return;
    }
    const issue = stripUndefined({
        id: uuidv4(),
        message: parsed.data.message,
        screenshot: parsed.data.screenshot,
        createdAt: new Date(),
        resolved: false,
    });
    pushBounded(issues, issue);
    res["json"]({ success: true, id: issue.id });
});
router.patch("/:id/resolve", (req, res) => {
    const issue = issues.find((entry) => entry.id === req.params.id);
    if (issue)
        issue.resolved = true;
    res["json"]({ success: true });
});
export default router;
