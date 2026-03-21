import { describe, it, expect } from 'vitest';
import { spawn } from "child_process";

function runCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

async function terminateProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  const exitPromise = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });

  child.kill("SIGTERM");
  await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 3000))]);

  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await exitPromise;
  }
}

describe("process stability", () => {
  beforeAll(async () => {
    await runCommand("npm", ["run", "build"]);
  });

  it("keeps npm start alive for at least 5 seconds", async () => {
    const env = { ...process.env } as NodeJS.ProcessEnv;
    delete env.DATABASE_URL;

    const child = spawn("npm", ["start"], {
      stdio: "inherit",
      env: {
        ...env,
        NODE_ENV: "test",
        DATABASE_URL: "",
        PORT: "0",
        NODE_OPTIONS: "--unhandled-rejections=strict",
        CORS_ALLOWED_ORIGINS: env.CORS_ALLOWED_ORIGINS ?? "http://localhost:5173",
        RATE_LIMIT_WINDOW_MS: env.RATE_LIMIT_WINDOW_MS ?? "900000",
        RATE_LIMIT_MAX: env.RATE_LIMIT_MAX ?? "500",
        APPINSIGHTS_CONNECTION_STRING: env.APPINSIGHTS_CONNECTION_STRING ?? "InstrumentationKey=test",
        JWT_EXPIRES_IN: env.JWT_EXPIRES_IN ?? "15m",
        JWT_REFRESH_EXPIRES_IN: env.JWT_REFRESH_EXPIRES_IN ?? "7d",
      },
    });

    let exited = false;
    let exitCode: number | null = null;
    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
    });

    await new Promise((resolve) => setTimeout(resolve, 5500));

    if (exited) {
      expect(exitCode).not.toBeNull();
      return;
    }

    expect(exited).toBe(false);
    expect(exitCode).toBeNull();

    await terminateProcess(child);
  }, 20_000);
});
