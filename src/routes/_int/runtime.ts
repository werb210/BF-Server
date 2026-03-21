import type { Request, Response } from "express";
import { getBuildInfo, getCorsAllowlistConfig } from "../../config";
import { checkDb } from "../../db";

type RuntimeResponse = {
  ok: boolean;
  uptime: number;
  env: string;
  build: {
    version: string | null;
    commit: string | null;
  };
  cors: {
    enabled: boolean | null;
  };
  db: {
    connected: boolean | null;
  };
  warnings: string[];
};

export async function runtimeHandler(_req: Request, res: Response): Promise<void> {
  const response: RuntimeResponse = {
    ok: true,
    uptime: process.uptime(),
    env: process.env.NODE_ENV || "unknown",
    build: { version: null, commit: null },
    cors: { enabled: null },
    db: { connected: null },
    warnings: [],
  };

  try {
    const { commitHash, buildTimestamp } = getBuildInfo();
    response.build = {
      version: buildTimestamp ?? null,
      commit: commitHash ?? null,
    };
  } catch {
    response.warnings.push("build_info_unavailable");
  }

  try {
    const allowlist = getCorsAllowlistConfig();
    response.cors = { enabled: Array.isArray(allowlist) };
  } catch {
    response.cors = { enabled: null };
    response.warnings.push("cors_config_unavailable");
  }

  try {
    await checkDb();
    response.db = { connected: true };
  } catch {
    response.db = { connected: false };
    response.warnings.push("db_unreachable");
  }

  res.status(200).json(response);
}
