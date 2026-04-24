-- ═══════════════════════════════════════════════════════════════════════════
-- FILE: migrations/105_seed_admin_users.sql  (NEW FILE)
-- Seeds Andrew Polturak as Admin with access to all three silos.
-- Fully idempotent — safe to run multiple times.
-- ═══════════════════════════════════════════════════════════════════════════

-- Ensure phone_number is nullable (in case 104 didn't land yet)
ALTER TABLE users
  ALTER COLUMN phone_number DROP NOT NULL;

UPDATE users SET status = UPPER(status)
  WHERE status IS NOT NULL AND status != UPPER(status);

INSERT INTO users (
  id,
  email,
  phone_number,
  password_hash,
  role,
  active,
  first_name,
  last_name,
  status,
  silo
)
VALUES (
  gen_random_uuid(),
  'andrew@boreal.financial',
  '+17802648467',
  '$2a$10$placeholder.hash.not.used.otp.login.only.xxxxxxxxxxxxxx',
  'Admin',
  true,
  'Andrew',
  'Polturak',
  'ACTIVE',
  'BF'
)
ON CONFLICT (phone_number) DO UPDATE SET
  first_name  = EXCLUDED.first_name,
  last_name   = EXCLUDED.last_name,
  role        = EXCLUDED.role,
  status      = EXCLUDED.status,
  active      = true,
  email       = EXCLUDED.email;

-- ═══════════════════════════════════════════════════════════════════════════
-- PORTAL NOTE — no code change needed for silo dropdown.
-- BusinessUnitSelector already shows all 3 silos to Admin role.
-- Non-admin users only see their assigned silo — already implemented.
-- ═══════════════════════════════════════════════════════════════════════════

-- TESTS:
-- SELECT phone_number, first_name, role, status FROM users
--   WHERE phone_number = '+17802648467';
-- → Should return: +17802648467 | Andrew | Admin | ACTIVE
--
-- Portal: Andrew enters +17802648467 on OTP page
-- → Receives SMS code → logs in → sees all three silos in topbar dropdown
-- → Dashboard loads with Prod: ok badge
-- ═══════════════════════════════════════════════════════════════════════════
