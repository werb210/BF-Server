import { Request, Response } from "express";
import { pool } from "../../db.js";

export const runtimeHandler = async (_req: Request, res: Response) => {
  let dbConnected = false;
  try {
    await pool.query("SELECT 1");
    dbConnected = true;
  } catch {
    dbConnected = false;
  }

  const authReady = typeof process.env.JWT_SECRET === "string" && process.env.JWT_SECRET.trim().length > 0;

  res["json"]({
    api: "ok",
    db: dbConnected ? "ok" : "error",
    auth: authReady ? "ok" : "error",
  });
};
