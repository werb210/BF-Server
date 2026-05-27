# BF-Server: Azure App Service Configuration

## Always On (REQUIRED)
Azure App Service auto-sleeps the app after ~20 min of idle on Free/Shared
tiers. When asleep, the first request blocks for 30-60s while the worker
cold-starts. Browser OTP clients time out at 60s (see bf-client v51).

To prevent this:
1. Azure Portal → App Services → **BF-Server**
2. Configuration → General settings → **Always On = On**
3. Save

This requires a Basic (B1) tier or higher. If currently on Free (F1) or
Shared (D1), upgrade the App Service plan first.

## Keep-warm fallback
Even with Always On, deployment slot swaps and platform-level restarts
can briefly idle the worker. BF_SERVER_BLOCK_v105 adds a 5-minute
self-ping that keeps a hot worker hot. This is defense-in-depth, NOT a
substitute for Always On.

## Operational verification
After enabling Always On, check that healthchecks show in the log every
minute (search for "/health" in the application log stream). If healths
stop for >2 minutes, Always On is not working.
