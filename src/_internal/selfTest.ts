import http from "http";

type TestCase = {
  name: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
};

function request(port: number, test: TestCase): Promise<boolean> {
  return new Promise((resolve) => {
    const data = test.body ? JSON.stringify(test.body) : null;

    const req = http.request(
      {
        hostname: "localhost",
        port,
        path: test.path,
        method: test.method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": data ? Buffer.byteLength(data) : 0,
        },
      },
      (res) => {
        resolve(res.statusCode !== undefined && res.statusCode < 500);
      },
    );

    req.on("error", () => resolve(false));

    if (data) req.write(data);
    req.end();
  });
}

export async function runSelfTest(port: number): Promise<void> {
  const tests: TestCase[] = [
    { name: "health", method: "GET", path: "/health" },
    { name: "otp-start", method: "POST", path: "/auth/otp/start", body: { phone: "123" } },
    { name: "otp-verify", method: "POST", path: "/auth/otp/verify", body: { code: "123456" } },
  ];

  console.log("Running startup self-test...");

  for (const t of tests) {
    const ok = await request(port, t);

    if (!ok) {
      console.error(`SELF-TEST FAILED: ${t.name} (${t.method} ${t.path})`);
      process.exit(1);
    }

    console.log(`PASS: ${t.name}`);
  }

  console.log("SELF-TEST PASSED");
}
