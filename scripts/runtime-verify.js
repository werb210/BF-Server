const { randomUUID } = require("crypto");
const http = require("http");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-access-secret";
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || "test-refresh-secret";
process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "15m";
process.env.JWT_REFRESH_EXPIRES_IN =
  process.env.JWT_REFRESH_EXPIRES_IN || "30d";
process.env.TWILIO_ACCOUNT_SID =
  process.env.TWILIO_ACCOUNT_SID || "ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
process.env.TWILIO_AUTH_TOKEN =
  process.env.TWILIO_AUTH_TOKEN || "test-auth-token";
process.env.TWILIO_VERIFY_SERVICE_SID =
  process.env.TWILIO_VERIFY_SERVICE_SID || "VA00000000000000000000000000000000";
process.env.LOGIN_LOCKOUT_THRESHOLD = process.env.LOGIN_LOCKOUT_THRESHOLD || "2";
process.env.LOGIN_LOCKOUT_MINUTES = process.env.LOGIN_LOCKOUT_MINUTES || "10";
process.env.PASSWORD_MAX_AGE_DAYS = process.env.PASSWORD_MAX_AGE_DAYS || "30";

const { buildAppWithApiRoutes } = require("../dist/app");
const { pool } = require("../dist/db");
const { signAccessToken } = require("../dist/auth/jwt");
const { ROLES } = require("../dist/auth/roles");
const { markReady } = require("../dist/startupState");

async function setupSchema() {
  await pool.query(`
    create table if not exists users (
      id uuid primary key,
      email text null,
      phone_number text null unique,
      phone text null,
      role text null,
      silo text null,
      lender_id uuid null,
      status text not null default 'active',
      active boolean not null default true,
      is_active boolean null,
      disabled boolean null,
      locked_until timestamptz null,
      phone_verified boolean not null default false,
      updated_at timestamptz null,
      token_version integer not null default 0
    );
  `);
  await pool.query(`
    create table if not exists lenders (
      id uuid primary key,
      name text not null,
      country text not null,
      submission_method text null,
      email text null,
      phone text null,
      website text null,
      postal_code text null,
      created_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists lender_products (
      id uuid primary key,
      lender_id uuid not null references lenders(id) on delete cascade,
      name text not null,
      description text null,
      active boolean not null default true,
      required_documents jsonb not null default '[]'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
}

function httpRequest({ method, path, token }) {
  const headers = { Accept: "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: 5099,
        path,
        method,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode, body: data });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function extractRoutePaths(routesBody) {
  if (!routesBody || !Array.isArray(routesBody.routes)) {
    return [];
  }
  const firstRoute = routesBody.routes[0];
  if (typeof firstRoute === "string") {
    return routesBody.routes.filter(Boolean);
  }
  if (firstRoute && typeof firstRoute.path === "string") {
    return routesBody.routes.map((route) => route.path).filter(Boolean);
  }
  return routesBody.routes
    .flatMap((group) => group.routes || [])
    .map((route) => route.path)
    .filter(Boolean);
}

async function run() {
  const app = buildAppWithApiRoutes();

  await setupSchema();
  markReady();

  const adminId = randomUUID();
  await pool.query(
    `insert into users (id, email, phone_number, phone, role, status, active, is_active, disabled)
     values ($1, $2, $3, $3, $4, 'active', true, true, false)`,
    [adminId, `runtime-${adminId}@example.com`, "+15555559999", ROLES.ADMIN]
  );

  const lenderId = randomUUID();
  await pool.query(
    `insert into lenders (id, name, country) values ($1, $2, $3)`,
    [lenderId, "Runtime Lender", "US"]
  );
  await pool.query(
    `insert into lender_products (id, lender_id, name, required_documents)
     values ($1, $2, $3, '[]'::jsonb)`,
    [randomUUID(), lenderId, "Runtime Product"]
  );

  const token = signAccessToken({
    sub: adminId,
    role: ROLES.ADMIN,
    tokenVersion: 0,
    silo: "default",
  });

  const server = await new Promise((resolve) => {
    const listener = app.listen(5099, "127.0.0.1", () => resolve(listener));
  });

  try {
    const health = await httpRequest({ method: "GET", path: "/api/_int/health" });
    if (health.status !== 200) {
      throw new Error(`/api/_int/health expected 200, got ${health.status}`);
    }

    const ready = await httpRequest({ method: "GET", path: "/api/_int/ready" });
    if (ready.status !== 200) {
      throw new Error(`/api/_int/ready expected 200, got ${ready.status}`);
    }

    const routesResponse = await httpRequest({
      method: "GET",
      path: "/api/_int/routes",
    });
    if (routesResponse.status !== 200) {
      throw new Error(`/api/_int/routes expected 200, got ${routesResponse.status}`);
    }
    const routesBody = JSON.parse(routesResponse.body || "{}");
    const routes = extractRoutePaths(routesBody);
    ["/api/users", "/api/lenders", "/api/lender-products"].forEach((path) => {
      if (!routes.includes(path)) {
        throw new Error(`/api/_int/routes missing ${path}`);
      }
    });

    const lenders = await httpRequest({
      method: "GET",
      path: "/api/lenders",
      token,
    });
    if (lenders.status === 500) {
      throw new Error("/api/lenders returned 500");
    }

    const products = await httpRequest({
      method: "GET",
      path: "/api/lender-products",
      token,
    });
    if (products.status === 500) {
      throw new Error("/api/lender-products returned 500");
    }

    console.log("runtime verify: OK");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
