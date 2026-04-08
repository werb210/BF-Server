"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const execa_1 = __importDefault(require("execa"));
const BASE_URL = "http://127.0.0.1:8080";
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
async function fetchWithTimeout(url, init, timeoutMs = 5000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    }
    finally {
        clearTimeout(timeout);
    }
}
async function waitForServer() {
    for (let i = 0; i < 40; i++) {
        try {
            const res = await fetchWithTimeout(`${BASE_URL}/health`);
            if (res.ok)
                return;
        }
        catch { }
        await sleep(1000);
    }
    throw new Error("Server did not start on port 8080");
}
async function runChecks() {
    console.log("→ Checking /health");
    const health = await fetchWithTimeout(`${BASE_URL}/health`);
    if (!health.ok)
        throw new Error("Health check failed");
    console.log("→ Checking auth");
    const auth = await fetchWithTimeout(`${BASE_URL}/api/auth/otp/start`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ phone: "1234567890" }),
    });
    if (!auth.ok)
        throw new Error("Auth endpoint failed");
    console.log("→ Checking application submit");
    const appSubmit = await fetchWithTimeout(`${BASE_URL}/api/applications`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            businessName: "E2E Test Corp",
            amount: 50000,
        }),
    });
    if (!appSubmit.ok)
        throw new Error("Application submit failed");
}
function startServer() {
    console.log("→ Starting BF-Server...");
    const server = (0, execa_1.default)("npm", ["run", "dev"], {
        cwd: ".",
        stdout: "inherit",
        stderr: "inherit",
    });
    return {
        server,
        ready: waitForServer(),
    };
}
async function main() {
    console.log("=== E2E TEST START ===");
    let server = null;
    let exitCode = 0;
    try {
        const started = startServer();
        server = started.server;
        await started.ready;
        console.log("→ Server ready");
        await runChecks();
        console.log("=== E2E PASS ===");
    }
    catch (err) {
        console.error("=== E2E FAIL ===");
        console.error(err.message || err);
        exitCode = 1;
    }
    finally {
        if (server) {
            console.log("→ Shutting down server...");
            server.kill("SIGTERM", {
                forceKillAfterTimeout: 2000,
            });
            await server.catch(() => undefined);
        }
        if (exitCode !== 0) {
            throw new Error("E2E checks failed");
        }
    }
}
void main();
