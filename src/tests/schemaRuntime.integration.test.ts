import { describe, it, expect } from 'vitest';
import { execFile } from "child_process";
import type { Server } from "http";
import jwt, { type SignOptions } from "jsonwebtoken";
import { promisify } from "util";
import { ROLES } from "../auth/roles";
import { startServer } from "../index";
import { resetStartupState } from "../startupState";
import { resolveBaseUrl } from "../__tests__/helpers/baseUrl";
import { pool } from "../db";
import { randomUUID } from "crypto";

const TOKEN_OPTIONS: SignOptions = {
  expiresIn: "1h",
  issuer: "boreal-staff-server",
  audience: "boreal-staff-portal",
};

const execFileAsync = promisify(execFile);

async function runCurl(
  args: string[],
  env: Record<string, string>
): Promise<string> {
  const { stdout } = await execFileAsync("curl", args, {
    env: { ...process.env, ...env },
  });
  const output = stdout.toString().trim();
  if (!output) {
    throw new Error(`Empty response for curl ${args.join(" ")}`);
  }
  return output;
}

describe("runtime schema verification", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
    server = null;
  });

  it("boots and returns 200s for lenders and lender-products", async () => {
    process.env.PORT = "0";
    process.env.NODE_ENV = "test";
    resetStartupState();

    server = await startServer();

    const userId = randomUUID();
    await pool.query(
      `insert into users (id, role, status, active)
       values ($1, $2, $3, true)`,
      [userId, ROLES.STAFF, "ACTIVE"]
    );

    const baseUrl = resolveBaseUrl(server ?? undefined);
    const base = new URL(baseUrl);
    const port = base.port;
    const token = jwt.sign(
      { sub: userId, role: ROLES.STAFF, tokenVersion: 0 },
      process.env.JWT_SECRET ?? "test-access-secret",
      TOKEN_OPTIONS
    );
    const env = { PORT: port, ACCESS_TOKEN: token };

    await runCurl(
      ["-sf", `http://127.0.0.1:${port}/api/_int/health`],
      env
    );
    await runCurl(
      [
        "-sf",
        `http://127.0.0.1:${port}/api/auth/me`,
        "-H",
        `Authorization: Bearer ${token}`,
      ],
      env
    );
    await runCurl(
      [
        "-sf",
        `http://127.0.0.1:${port}/api/lenders`,
        "-H",
        `Authorization: Bearer ${token}`,
      ],
      env
    );
    await runCurl(
      [
        "-sf",
        `http://127.0.0.1:${port}/api/lender-products`,
        "-H",
        `Authorization: Bearer ${token}`,
      ],
      env
    );
  });
});
