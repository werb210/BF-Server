#!/usr/bin/env node
/* eslint-disable no-console */
const http = require("http");
const https = require("https");
const { URL } = require("url");
const jwt = require("jsonwebtoken");
const { Client } = require("pg");

const BASE_URL = process.env.SERVER_BASE_URL || "http://localhost:8080";

const ROLE_CONFIGS = [
  {
    label: "Admin",
    envPhone: "ADMIN_PHONE",
    envCode: "ADMIN_OTP_CODE",
    role: "Admin",
  },
  {
    label: "Staff",
    envPhone: "STAFF_PHONE",
    envCode: "STAFF_OTP_CODE",
    role: "Staff",
  },
  {
    label: "LenderA",
    envPhone: "LENDER_A_PHONE",
    envCode: "LENDER_A_OTP_CODE",
    role: "Lender",
  },
  {
    label: "LenderB",
    envPhone: "LENDER_B_PHONE",
    envCode: "LENDER_B_OTP_CODE",
    role: "Lender",
  },
  {
    label: "Referrer",
    envPhone: "REFERRER_PHONE",
    envCode: "REFERRER_OTP_CODE",
    role: "Referrer",
  },
];

const DEFAULT_OTP_CODE = process.env.OTP_CODE;
const DATABASE_URL = process.env.DATABASE_URL;

const EXPECTED_JWT_ISS = "boreal-staff-server";
const EXPECTED_JWT_AUD = "boreal-staff-portal";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function getRoleCredentials(config) {
  const phone = requireEnv(config.envPhone);
  const code = process.env[config.envCode] || DEFAULT_OTP_CODE;
  if (!code) {
    throw new Error(
      `Missing OTP code for ${config.label}. Set ${config.envCode} or OTP_CODE.`
    );
  }
  return { phone, code };
}

function buildRequestOptions(url, method, token, body) {
  const headers = {
    Accept: "application/json",
  };
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload);
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return {
    url,
    options: {
      method,
      headers,
    },
    payload,
  };
}

async function httpRequest({ method, path, token, body }) {
  const url = new URL(path, BASE_URL);
  const client = url.protocol === "https:" ? https : http;
  const { options, payload } = buildRequestOptions(url, method, token, body);

  return new Promise((resolve, reject) => {
    const req = client.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        const contentType = res.headers["content-type"] || "";
        const isJson = contentType.includes("application/json");
        const parsed = isJson && data ? safeJsonParse(data) : null;
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: data,
          json: parsed,
        });
      });
    });
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function safeJsonParse(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function extractErrorCode(response) {
  const body = response.json || safeJsonParse(response.body || "");
  if (body?.error?.code) return body.error.code;
  if (body?.error) return body.error;
  if (body?.code) return body.code;
  if (body?.error?.message) return body.error.message;
  return null;
}

function extractRequestId(response) {
  const body = response.json || safeJsonParse(response.body || "");
  return body?.requestId || response.headers["x-request-id"] || null;
}

function assert(condition, message, response) {
  if (!condition) {
    const requestId = response ? extractRequestId(response) : null;
    const errorCode = response ? extractErrorCode(response) : null;
    const suffix = [
      requestId ? `requestId=${requestId}` : null,
      errorCode ? `error=${errorCode}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    const details = suffix ? ` (${suffix})` : "";
    throw new Error(`${message}${details}`);
  }
}

function assertNoServerError(response, label) {
  assert(response.status !== 500, `${label} returned 500`, response);
  if (typeof response.body === "string" && response.body.includes("\n    at ")) {
    throw new Error(`${label} leaked stack trace`);
  }
}

function logPass(label) {
  console.log(`PASS ${label}`);
}

function jwtAudienceMatches(aud) {
  if (Array.isArray(aud)) {
    return aud.includes(EXPECTED_JWT_AUD);
  }
  return aud === EXPECTED_JWT_AUD;
}

async function otpLoginFlow({ label, phone, code, role }) {
  const start = await httpRequest({
    method: "POST",
    path: "/api/auth/otp/start",
    body: { phone },
  });
  assertNoServerError(start, `${label} otp start`);
  assert(start.status === 200, `${label} otp start expected 200`, start);
  assert(start.json?.ok === true, `${label} otp start ok=true`, start);
  assert(start.json?.data?.sent === true, `${label} otp start sent=true`, start);
  logPass(`${label} POST /api/auth/otp/start`);

  const verify = await httpRequest({
    method: "POST",
    path: "/api/auth/otp/verify",
    body: { phone, code },
  });
  assertNoServerError(verify, `${label} otp verify`);
  assert(verify.status === 200, `${label} otp verify expected 200`, verify);
  assert(verify.json?.ok === true, `${label} otp verify ok=true`, verify);
  assert(verify.json?.user?.role === role, `${label} role mismatch`, verify);
  assert(verify.json?.accessToken, `${label} accessToken missing`, verify);
  assert(verify.json?.refreshToken, `${label} refreshToken missing`, verify);

  const token = verify.json.accessToken;
  const payload = jwt.decode(token) || {};
  assert(
    payload.iss === EXPECTED_JWT_ISS,
    `${label} JWT iss mismatch`,
    verify
  );
  assert(
    jwtAudienceMatches(payload.aud),
    `${label} JWT aud mismatch`,
    verify
  );
  assert(
    Array.isArray(payload.capabilities) && payload.capabilities.length > 0,
    `${label} JWT capabilities missing`,
    verify
  );

  logPass(`${label} POST /api/auth/otp/verify`);

  const me = await httpRequest({
    method: "GET",
    path: "/api/auth/me",
    token,
  });
  assertNoServerError(me, `${label} auth me`);
  assert(me.status === 200, `${label} auth me expected 200`, me);
  assert(me.json?.ok === true, `${label} auth me ok=true`, me);
  assert(me.json?.role === role, `${label} auth me role mismatch`, me);
  assert(me.json?.silo === "default", `${label} auth me silo mismatch`, me);
  logPass(`${label} GET /api/auth/me`);

  return { token, userId: me.json.userId };
}

async function assertLenderIdBindings(db, usersByRole) {
  const queries = Object.values(usersByRole).map(async (user) => {
    const res = await db.query(
      "select lender_id from users where id = $1",
      [user.userId]
    );
    const lenderId = res.rows[0]?.lender_id ?? null;
    return { role: user.role, lenderId };
  });
  const results = await Promise.all(queries);
  for (const result of results) {
    if (result.role === "Lender") {
      assert(
        result.lenderId,
        `Lender user missing lender_id in DB for role ${result.role}`
      );
    } else {
      assert(
        result.lenderId === null,
        `Non-lender user has lender_id for role ${result.role}`
      );
    }
  }
}

async function main() {
  const shouldValidateLenderBindings = Boolean(DATABASE_URL);
  if (!shouldValidateLenderBindings) {
    console.warn("DATABASE_URL not set; skipping lender_id binding validation.");
  }

  const health = await httpRequest({ method: "GET", path: "/api/_int/health" });
  assertNoServerError(health, "health");
  assert(health.status === 200, "/api/_int/health expected 200", health);
  assert(health.json?.ok === true, "/api/_int/health ok=true", health);
  logPass("GET /api/_int/health");

  const ready = await httpRequest({ method: "GET", path: "/api/_int/ready" });
  assertNoServerError(ready, "ready");
  assert(ready.status === 200, "/api/_int/ready expected 200", ready);
  assert(ready.json?.ok === true, "/api/_int/ready ok=true", ready);
  assert(
    !JSON.stringify(ready.json || {}).includes("fatal_schema_mismatch"),
    "/api/_int/ready fatal_schema_mismatch present",
    ready
  );
  logPass("GET /api/_int/ready");

  const routes = await httpRequest({ method: "GET", path: "/api/_int/routes" });
  assertNoServerError(routes, "routes");
  assert(routes.status === 200, "/api/_int/routes expected 200", routes);
  const routePaths = Array.isArray(routes.json?.routes)
    ? routes.json.routes
        .flatMap((group) => group.routes || [])
        .map((route) => route.path)
    : [];
  ["/api/users", "/api/lenders", "/api/lender-products"].forEach((path) => {
    assert(routePaths.includes(path), `/api/_int/routes missing ${path}`, routes);
  });
  logPass("GET /api/_int/routes");

  const usersByRole = {};
  for (const config of ROLE_CONFIGS) {
    const { phone, code } = getRoleCredentials(config);
    const result = await otpLoginFlow({
      label: config.label,
      phone,
      code,
      role: config.role,
    });
    usersByRole[config.label] = { ...result, role: config.role };
  }

  if (shouldValidateLenderBindings) {
    const db = new Client({ connectionString: DATABASE_URL });
    await db.connect();
    try {
      await assertLenderIdBindings(db, usersByRole);
      logPass("DB lender_id bindings");
    } finally {
      await db.end();
    }
  }

  for (const config of ROLE_CONFIGS) {
    const user = usersByRole[config.label];
    const me = await httpRequest({
      method: "GET",
      path: "/api/users/me",
      token: user.token,
    });
    assertNoServerError(me, `${config.label} users me`);
    assert(me.status === 200, `${config.label} /api/users/me expected 200`, me);
    assert(me.json?.ok === true, `${config.label} /api/users/me ok=true`, me);
    logPass(`${config.label} GET /api/users/me`);
  }

  const admin = usersByRole.Admin;
  const staff = usersByRole.Staff;
  const lenderA = usersByRole.LenderA;
  const lenderB = usersByRole.LenderB;
  const referrer = usersByRole.Referrer;

  const adminList = await httpRequest({
    method: "GET",
    path: "/api/users",
    token: admin.token,
  });
  assertNoServerError(adminList, "Admin list users");
  assert(adminList.status === 200, "Admin list users expected 200", adminList);
  assert(adminList.json?.ok === true, "Admin list users ok=true", adminList);
  logPass("Admin GET /api/users");

  const staffList = await httpRequest({
    method: "GET",
    path: "/api/users",
    token: staff.token,
  });
  assertNoServerError(staffList, "Staff list users");
  assert(staffList.status === 403, "Staff list users expected 403", staffList);
  logPass("Staff GET /api/users (403)");

  const disabledPhone = process.env.DISABLED_PHONE;
  if (disabledPhone) {
    const disabledCode = process.env.DISABLED_OTP_CODE || DEFAULT_OTP_CODE;
    if (!disabledCode) {
      throw new Error("DISABLED_OTP_CODE or OTP_CODE required for disabled user.");
    }
    const disabledVerify = await httpRequest({
      method: "POST",
      path: "/api/auth/otp/verify",
      body: { phone: disabledPhone, code: disabledCode },
    });
    assertNoServerError(disabledVerify, "Disabled user verify");
    assert(
      disabledVerify.status === 403,
      "Disabled user verify expected 403",
      disabledVerify
    );
    logPass("Disabled user OTP verify blocked (403)");
  }

  const staffCreateUser = await httpRequest({
    method: "POST",
    path: "/api/users",
    token: staff.token,
    body: {
      phoneNumber: "+15555550001",
      role: "Staff",
    },
  });
  assertNoServerError(staffCreateUser, "Staff create user");
  assert(
    staffCreateUser.status === 403,
    "Staff POST /api/users expected 403",
    staffCreateUser
  );
  logPass("Staff POST /api/users (403)");

  const lenderListUsers = await httpRequest({
    method: "GET",
    path: "/api/users",
    token: lenderA.token,
  });
  assertNoServerError(lenderListUsers, "Lender list users");
  assert(
    lenderListUsers.status === 403,
    "Lender GET /api/users expected 403",
    lenderListUsers
  );
  logPass("Lender GET /api/users (403)");

  const referrerLenders = await httpRequest({
    method: "GET",
    path: "/api/lenders",
    token: referrer.token,
  });
  assertNoServerError(referrerLenders, "Referrer list lenders");
  assert(
    referrerLenders.status === 403,
    "Referrer GET /api/lenders expected 403",
    referrerLenders
  );
  logPass("Referrer GET /api/lenders (403)");

  const adminLenders = await httpRequest({
    method: "GET",
    path: "/api/lenders",
    token: admin.token,
  });
  assertNoServerError(adminLenders, "Admin list lenders");
  assert(adminLenders.status === 200, "Admin GET /api/lenders expected 200", adminLenders);
  assert(Array.isArray(adminLenders.json), "Admin lenders response not array", adminLenders);
  logPass("Admin GET /api/lenders");

  const lenderCreate = await httpRequest({
    method: "POST",
    path: "/api/lenders",
    token: admin.token,
    body: {
      name: `Codex Lender ${Date.now()}`,
      country: "US",
      submissionMethod: "api",
    },
  });
  assertNoServerError(lenderCreate, "Admin create lender");
  assert(lenderCreate.status === 201, "Admin POST /api/lenders expected 201", lenderCreate);
  assert(lenderCreate.json?.country, "Lender create missing country", lenderCreate);
  logPass("Admin POST /api/lenders");

  const staffCreateLender = await httpRequest({
    method: "POST",
    path: "/api/lenders",
    token: staff.token,
    body: {
      name: `Codex Lender Staff ${Date.now()}`,
      country: "US",
    },
  });
  assertNoServerError(staffCreateLender, "Staff create lender");
  assert(staffCreateLender.status === 403, "Staff POST /api/lenders expected 403", staffCreateLender);
  logPass("Staff POST /api/lenders (403)");

  const lenderAList = await httpRequest({
    method: "GET",
    path: "/api/lenders",
    token: lenderA.token,
  });
  assertNoServerError(lenderAList, "Lender A list lenders");
  assert(lenderAList.status === 200, "Lender A GET /api/lenders expected 200", lenderAList);
  assert(Array.isArray(lenderAList.json), "Lender A lenders response not array", lenderAList);
  const lenderARecord = lenderAList.json[0];
  assert(lenderARecord?.id, "Lender A lender record missing id", lenderAList);

  const lenderBList = await httpRequest({
    method: "GET",
    path: "/api/lenders",
    token: lenderB.token,
  });
  assertNoServerError(lenderBList, "Lender B list lenders");
  assert(lenderBList.status === 200, "Lender B GET /api/lenders expected 200", lenderBList);
  const lenderBRecord = Array.isArray(lenderBList.json) ? lenderBList.json[0] : null;
  assert(lenderBRecord?.id, "Lender B lender record missing id", lenderBList);

  const lenderAProductCreate = await httpRequest({
    method: "POST",
    path: "/api/lender-products",
    token: lenderA.token,
    body: {
      name: `Codex Product ${Date.now()}`,
      required_documents: [],
    },
  });
  assertNoServerError(lenderAProductCreate, "Lender A create product");
  assert(
    [200, 201].includes(lenderAProductCreate.status),
    "Lender A POST /api/lender-products expected 200/201",
    lenderAProductCreate
  );
  logPass("Lender A POST /api/lender-products");

  const staffProductCreate = await httpRequest({
    method: "POST",
    path: "/api/lender-products",
    token: staff.token,
    body: {
      lenderId: lenderARecord.id,
      name: `Codex Staff Product ${Date.now()}`,
      required_documents: [],
    },
  });
  assertNoServerError(staffProductCreate, "Staff create product");
  assert(
    staffProductCreate.status === 403,
    "Staff POST /api/lender-products expected 403",
    staffProductCreate
  );
  logPass("Staff POST /api/lender-products (403)");

  const lenderAProducts = await httpRequest({
    method: "GET",
    path: `/api/lenders/${lenderARecord.id}/products`,
    token: lenderA.token,
  });
  assertNoServerError(lenderAProducts, "Lender A list products");
  assert(
    lenderAProducts.status === 200,
    "Lender A GET /api/lenders/:id/products expected 200",
    lenderAProducts
  );
  logPass("Lender A GET /api/lenders/:id/products");

  const lenderBProducts = await httpRequest({
    method: "GET",
    path: `/api/lenders/${lenderARecord.id}/products`,
    token: lenderB.token,
  });
  assertNoServerError(lenderBProducts, "Lender B list other products");
  assert(
    lenderBProducts.status === 403,
    "Lender B GET /api/lenders/:id/products expected 403",
    lenderBProducts
  );
  logPass("Lender B GET /api/lenders/:id/products (403)");

  const lenderAProductId = lenderAProductCreate.json?.id;
  assert(lenderAProductId, "Lender A product id missing", lenderAProductCreate);

  const lenderBUpdate = await httpRequest({
    method: "PATCH",
    path: `/api/lender-products/${lenderAProductId}`,
    token: lenderB.token,
    body: { name: "Cross Edit Attempt", required_documents: [] },
  });
  assertNoServerError(lenderBUpdate, "Lender B update other product");
  assert(
    lenderBUpdate.status === 403,
    "Lender B PATCH /api/lender-products/:id expected 403",
    lenderBUpdate
  );
  logPass("Lender B PATCH /api/lender-products/:id (403)");

  const staffProducts = await httpRequest({
    method: "GET",
    path: "/api/lender-products",
    token: staff.token,
  });
  assertNoServerError(staffProducts, "Staff list products");
  assert(
    staffProducts.status === 200,
    "Staff GET /api/lender-products expected 200",
    staffProducts
  );
  logPass("Staff GET /api/lender-products");

  const forbiddenRequest = staffCreateUser;
  assert(
    forbiddenRequest.status === 403,
    "Expected forbidden request to return 403",
    forbiddenRequest
  );

  const opsView = await httpRequest({
    method: "GET",
    path: "/api/admin/ops/kill-switches",
    token: admin.token,
  });
  assertNoServerError(opsView, "Admin ops kill-switches");
  assert(opsView.status === 200, "Admin GET /api/admin/ops/kill-switches expected 200", opsView);
  logPass("Admin GET /api/admin/ops/kill-switches");

  const auditEvents = await httpRequest({
    method: "GET",
    path: "/api/admin/audit/events?limit=5",
    token: admin.token,
  });
  assertNoServerError(auditEvents, "Admin audit events");
  assert(auditEvents.status === 200, "Admin GET /api/admin/audit/events expected 200", auditEvents);
  assert(Array.isArray(auditEvents.json?.events), "Audit events missing", auditEvents);
  assert(
    auditEvents.json.events.length > 0,
    "Audit events empty after activity",
    auditEvents
  );
  logPass("Admin GET /api/admin/audit/events");

  console.log("SERVER GREEN");
}

main().catch((err) => {
  if (
    err?.code === "ECONNREFUSED" ||
    (Array.isArray(err?.errors) &&
      err.errors.some((inner) => inner?.code === "ECONNREFUSED"))
  ) {
    console.warn("SERVER_BASE_URL is not reachable; skipping codex server test.");
    process.exit(0);
  }
  console.error(err.message || err);
  process.exit(1);
});
