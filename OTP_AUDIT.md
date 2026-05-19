# OTP Audit — BF-Server

## 1. OTP code paths found (files)

### Step 1 command output

```bash
git ls-files | xargs grep -nE '(otp|verify)[A-Z_]*|TWILIO_VERIFY|twilio\.verify|verifications\.create|verificationChecks\.create' --include='*.ts' --include='*.tsx' --include='*.js' --include='*.sql' 2>/dev/null
```

- Output captured during audit (truncated here to OTP-relevant runtime paths):
  - `src/routes/auth.ts`
  - `src/modules/auth/auth.service.ts`
  - `src/modules/auth/auth.repo.ts`
  - `src/modules/auth/phone.ts`
  - `src/services/otp.ts`
  - `src/services/twilio.ts`
  - `src/middleware/rateLimit.ts`
  - `src/config/runtime.ts`
  - `src/routes/auth/otp.ts`
  - `src/lib/twilioClient.ts`
  - `src/index.ts`
  - `src/routes/_int.ts`
  - plus tests/scripts/migrations listed by grep output.

```bash
git ls-files | xargs grep -nE '5878881837|\+1[ -]?587[ -]?888|hardcod|allowList|allowlist|allowedPhone|phoneAllow|verifiedNumber' 2>/dev/null
```

- Matches include seeded/default operator number references (`+15878881837`) in:
  - `.env.example`
  - `src/db/seed.ts`
  - non-OTP business routes/tests/scripts.
- No direct OTP allowlist branch for `+15878881837` was found in `src/routes/auth.ts`, `src/modules/auth/auth.service.ts`, `src/services/otp.ts`, or `src/modules/auth/phone.ts`.

---

## 2. Handler dumps (start, verify, normalize, etc.)

### `/api/auth/otp/start` and `/api/auth/otp/verify` (full handlers)
Source: `src/routes/auth.ts`.

```ts
// lines 43-107
router.post("/otp/start", async (req, res) => {
  try {
    const { phone } = req.body;

    if (!isValidPhone(phone)) {
      return res.status(400).json({ error: "Phone is required" });
    }

    if (isTest) {
      if (process.env.NODE_ENV === "production") {
        console.error("[auth.otpStart] FATAL: isTest=true with NODE_ENV=production -- refusing");
        return res.status(500).json({ error: "auth_misconfigured" });
      }
      const store = (globalThis.__otpStore ??= {});
      store[phone] = {
        code: "000000",
        createdAt: Date.now(),
        attempts: 0,
        verified: false,
      };

      return res.status(200).json({
        status: "ok",
        data: { sent: true },
      });
    }

    if (process.env.NODE_ENV !== "test" && !process.env.TWILIO_VERIFY_SERVICE_SID) {
      throw new Error("Missing Twilio Verify SID");
    }

    const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
    if (!serviceSid) {
      throw new Error("Missing Twilio Verify SID");
    }

    const client = getTwilioClient();
    const verification = await client.verify.v2
      .services(serviceSid)
      .verifications.create({
        to: phone,
        channel: "sms",
      });

    return res.status(200).json({
      status: "ok",
      data: { sent: true },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown OTP error";
    console.error("❌ OTP ERROR:", message);

    return res.status(500).json({
      error: "OTP failed",
    });
  }
});

// lines 110-232
router.post("/otp/verify", async (req, res) => {
  const { phone, code } = req.body;

  if (isTest) {
    if (process.env.NODE_ENV === "production") {
      console.error("[auth.otpVerify] FATAL: isTest=true with NODE_ENV=production -- refusing");
      return res.status(500).json({ error: "auth_misconfigured" });
    }
    const store = globalThis.__otpStore ?? {};
    const record = store[phone];
    if (!record || code !== "000000") {
      return res.status(401).json({ error: "Invalid code" });
    }
    record.verified = true;
    try {
      const token = signAccessToken({ sub: `test-user:${phone}`, role: ROLES.STAFF, tokenVersion: 0, phone });
      return res.status(200).json({ status: "ok", data: { token } });
    } catch {
      return res.status(500).json({ error: "auth not configured" });
    }
  }

  if (!phone || !code) {
    return res.status(400).json({ error: "Phone and code are required" });
  }

  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!serviceSid) {
    return res.status(500).json({ error: "OTP failed" });
  }

  try {
    const twilioClient = getTwilioClient();
    const verificationCheck = await twilioClient.verify.v2
      .services(serviceSid)
      .verificationChecks.create({ to: phone, code });

    if (verificationCheck.status !== "approved") {
      return res.status(401).json({ error: "Invalid code" });
    }

    // ... user lookup and token generation ...
    return res.status(200).json({ status: "ok", data: { token, hasSubmittedApplication, submittedApplicationId } });
  } catch (_err) {
    return res.status(401).json({ error: "Invalid code" });
  }
});
```

### Phone normalization helper(s)
Source: `src/modules/auth/phone.ts` (full file).

```ts
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length !== 11 || !digits.startsWith("1")) {
    throw new Error("Invalid phone number");
  }
  return `+${digits}`;
}

export function normalizeOtpPhone(phone: unknown): string | null {
  if (typeof phone !== "string") return null;
  try {
    const normalized = normalizePhone(phone);
    if (!normalized.startsWith("+")) throw new Error("invalid_phone");
    return normalized;
  } catch {
    return null;
  }
}

export function normalizePhoneNumber(phone: unknown): string | null {
  if (typeof phone !== "string") return null;
  try {
    return normalizePhone(phone);
  } catch {
    return null;
  }
}
```

### Rate limiter / OTP guard wrappers
Source: `src/middleware/rateLimit.ts`.

```ts
export const otpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: safeKeyGenerator,
  validate: { xForwardedForHeader: false, trustProxy: false },
});
```

### NODE_ENV / test branch flags
- `src/config/runtime.ts`: `export const isTest = process.env.NODE_ENV === "test";`
- `src/routes/auth.ts`: explicit `if (isTest)` and guard `if (process.env.NODE_ENV === "production")`.
- `src/services/otp.ts`: module-level `isTest` and test bypasses.

---

## 3. Env var usage

Observed OTP-related env vars:
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_VERIFY_SERVICE_SID`
- `NODE_ENV`
- `JWT_SECRET`

Where used:
- `src/routes/auth.ts`: reads Twilio SID/token env via `getTwilioClient()` and `TWILIO_VERIFY_SERVICE_SID` in both handlers.
- `src/services/otp.ts`: enforces Twilio envs in non-test mode, sends/checks Verify via `TWILIO_VERIFY_SERVICE_SID`.
- `src/index.ts` / `src/routes/_int.ts`: startup and diagnostics validate Verify SID presence/format.

Twilio account/service identification:
- Service SID is supplied from env var `TWILIO_VERIFY_SERVICE_SID` (present in code).
- Account SID is supplied from env var `TWILIO_ACCOUNT_SID`.
- Code *does* read test mode flag via `NODE_ENV === "test"`.
- No separate `MOCK_TWILIO`, `BYPASS_OTP`, or `TEST_MODE` env var was found in OTP runtime paths.

---

## 4. Recent commits

Command:
```bash
git log --since='30 days ago' --pretty='%h %ad %s' --date=short -- $(git ls-files | xargs grep -l 'otp\|verify' 2>/dev/null) | head -50
```

Output:
- `20c568e 2026-05-17 Add client voice/doc endpoints and communications routing fixes`
- `127ec61 2026-05-16 Add two-stage required docs foundation and portal form responses`
- `07bef19 2026-05-16 Fix auth-time silo resolution for authed requests`
- `a7c6bad 2026-05-15 Harden banking analysis auth and remove dead lender/session routes`
- `30dab42 2026-05-12 Add Maya staff pipeline-query endpoint with audit logging`
- `0dbdb0d 2026-05-08 Mark lender matches stale on OCR success`
- `2a4c70c 2026-05-07 Add SignNow real-path PDF generation and client integration`
- `729a43d 2026-05-07 Increase default OCR timeout to 120s`
- `fc2405d 2026-05-06 Fix readiness draft status to satisfy applications constraint`
- `efd09ff 2026-05-06 Fix silo resolution and readiness/contact flow handling`
- `e71f26a 2026-05-06 Make SignNow webhook secret optional for unpaid plan`

---

## 5. Migrations

Command:
```bash
ls migrations/ | grep -iE 'otp|auth|user|phone'
```

Matched files were fully dumped during audit. OTP/phone-critical ones:
- `019_auth_phone_otp.sql`
- `022_users_phone_fallback.sql`
- `024_auth_otp_verifications.sql`
- `089_otp_codes.sql`
- `090_otp_codes_production_hardening.sql`

Notable constraints:
- `019_auth_phone_otp.sql` adds unique constraint `users_phone_number_unique` on `users(phone_number)`.
- No migration found that hardcodes `+15878881837` into OTP delivery logic.

---

## 6. Hypotheses ranked

1. **Phone formatting mismatch between client input and stored user phone** (high)
   - `src/routes/auth.ts` sends raw `phone` to Twilio and also uses raw `phone` for `findAuthUserByPhone(phone)` in verify.
   - Repo lookup normalizes aggressively in `auth.repo.ts`, but if input is malformed/non-11-digit NANP, normalization returns null and user lookup fails.
   - Could explain one number working if it is consistently entered in exact expected format.

2. **Test-mode/non-test divergence across deployed runtime path** (high)
   - Multiple OTP implementations exist (`src/routes/auth.ts`, `src/modules/auth/auth.service.ts`, `src/routes/auth/otp.ts`, `src/services/otp.ts`).
   - If deployed route wiring uses a different path than expected, behavior may differ silently.

3. **Error-swallowing pattern causing generic success/failure semantics** (medium)
   - In `start`: catch returns `500 {error:"OTP failed"}`; not silent 200.
   - In `verify`: catch coerces to `401 Invalid code`, masking Twilio-specific failure reason.
   - If client ignores non-200 payload details, operators may perceive silent failure.

4. **Twilio Verify service-level restrictions/config** (medium-high, external to code)
   - Code consistently uses `TWILIO_VERIFY_SERVICE_SID`; if that Verify Service has geo/safe-list/fraud guard settings, one number may pass while others are blocked.
   - This is not visible in repo code; must check Twilio console logs.

5. **Server-side allowlist for OTP delivery** (low)
   - **No direct allowlist branch for OTP send/verify** found in core OTP runtime handlers.
   - `+15878881837` appears in seed/default/test content and non-OTP business routes.

6. **Country-code filter** (medium)
   - `normalizePhone` requires 11 digits starting with `1` -> US/Canada only.
   - Non-`+1` numbers are invalid in normalized paths.

7. **Migration constraint issue on phone column** (low-medium)
   - Unique constraint on `users.phone_number` exists, but that would affect account data integrity, not Twilio send path directly.

Binary answers requested:
- server-side allowlist: **No in OTP send/verify code paths found**.
- phone normalization output divergence: **Yes**.
- country-code filter: **Yes** (must be leading `1`).
- dev/test mode mock for non-allowlisted numbers: **No allowlisted split; yes generic test-mode bypass via `NODE_ENV===test`**.
- error-swallowing with 200 on Twilio reject: **No** (returns 500 or 401; no explicit 200 on Twilio reject in examined handlers).
- migration unique/check on phone: **Yes**, unique on `users.phone_number`.

---

## 7. Recommended next-step queries (if needed)

1. Confirm active route implementation in production boot wiring:
   - Is `/api/auth/otp/start` bound to `src/routes/auth.ts` or another router (`src/routes/auth/otp.ts` / `modules/auth` facade)?
2. Pull Twilio Verify logs for failed attempts (same timestamps) to inspect provider-side error codes.
3. Compare input formats from HAR for working vs failing numbers (exact `phone` payload string).
4. Verify database `users.phone_number` values are E.164 `+1...` for failing users.
5. Check deployed env for `TWILIO_VERIFY_SERVICE_SID`, `TWILIO_ACCOUNT_SID`, and `NODE_ENV` consistency.

