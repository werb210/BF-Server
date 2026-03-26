import type { Request, Response } from "express";
import { v4 as uuid } from "uuid";

const supportSessions: Array<{
  id: string;
  source: string;
  createdAt: number;
  status: "open" | "closed";
}> = [];

const issueReports: Array<{
  id: string;
  description: string | undefined;
  hasScreenshot: boolean;
  createdAt: number;
}> = [];

const websiteEvents: Array<{
  event: string | undefined;
  source: string | undefined;
  timestamp: number;
}> = [];

const webLeads: Array<Record<string, unknown> & { id: string; createdAt: number }> = [];
const MAX_ITEMS = 500;

function pushBounded<T>(arr: T[], item: T): void {
  arr.push(item);
  if (arr.length > MAX_ITEMS) {
    arr.shift();
  }
}

export const SupportController = {
  createSession(req: Request, res: Response): void {
    const session = {
      id: uuid(),
      source: (req.body as { source?: string }).source ?? "website",
      createdAt: Date.now(),
      status: "open" as const,
    };

    pushBounded(supportSessions, session);
    res.json({ success: true, session });
  },

  fetchQueue(_req: Request, res: Response): void {
    res.json({ sessions: supportSessions.filter((session) => session.status === "open") });
  },

  createIssue(req: Request, res: Response): void {
    const payload = req.body as { description?: string; screenshot?: string };
    const issue = {
      id: uuid(),
      description: payload.description,
      hasScreenshot: Boolean(payload.screenshot),
      createdAt: Date.now(),
    };

    pushBounded(issueReports, issue);
    res.json({ success: true });
  },

  fetchIssues(_req: Request, res: Response): void {
    res.json({ issues: issueReports });
  },

  createWebLead(req: Request, res: Response): void {
    const lead = {
      id: uuid(),
      ...(req.body as Record<string, unknown>),
      createdAt: Date.now(),
    };

    pushBounded(webLeads, lead);
    res.json({ success: true });
  },

  fetchWebLeads(_req: Request, res: Response): void {
    res.json({ leads: webLeads });
  },

  trackEvent(req: Request, res: Response): void {
    const payload = req.body as { event?: string; source?: string };
    pushBounded(websiteEvents, {
      event: payload.event,
      source: payload.source,
      timestamp: Date.now(),
    });

    res.json({ success: true });
  },

  fetchEvents(_req: Request, res: Response): void {
    res.json({ events: websiteEvents.slice(-100) });
  },
};
