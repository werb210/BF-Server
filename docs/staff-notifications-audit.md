# Staff Notifications Audit (Server + Portal + Dialer Parity Plan)

## 1) Server endpoint map (confirmed)
PWA routes are mounted as:
- `src/routes/routeRegistry.ts` includes `{ path: "/pwa", router: pwaRoutes }`
- `src/app.ts` mounts every route at ``/api${entry.path}``

So the effective API endpoints are:
- `POST /api/pwa/subscribe`
- `DELETE /api/pwa/unsubscribe`
- `GET /api/pwa/notifications`
- `POST /api/pwa/notifications/:id/ack`
- `GET /api/pwa/runtime`
- `GET /api/pwa/health` (admin-only)

## 2) Server notification creation and persistence paths
Primary flow is:
1. Caller invokes `sendNotification(...)` in `src/services/pushService.ts`.
2. Service builds payload hash and writes an audit row with `createPwaNotificationAudit(...)`.
3. Service sends web push via `webpush.sendNotification(...)` to all user subscriptions.
4. Client reads notifications through `GET /api/pwa/notifications` and acks through `POST /api/pwa/notifications/:id/ack`.

Key server files:
- Route handlers: `src/routes/pwa.ts`
- DB repository: `src/repositories/pwa.repo.ts`
- Push sender + audit insert: `src/services/pushService.ts`
- Non-prod internal test push endpoint: `src/routes/_int/pwa.ts` at `POST /api/_int/pwa/test-push`

## 3) Portal client findings
Portal repository inspected: `werb210/Staff-Portal`.

Findings:
- Portal has in-app notification UI/state (`NotificationCenter`, `notifications.store`) and WebSocket-triggered notifications.
- Portal currently does **not** call `/api/pwa/subscribe`, `/api/pwa/notifications`, or `/api/pwa/notifications/:id/ack`.
- Portal `usePushNotifications` manages browser permission/subscription objects locally, but does not post subscription to server endpoints.

Implication:
- If Dialer is meant to behave exactly like the current Portal implementation, parity is with local in-app notifications + existing event sources.
- If Dialer is meant to behave like the **server PWA notification model**, both Portal and Dialer need API wiring to `/api/pwa/*`.

## 4) Dialer parity implementation blueprint (recommended target: server PWA parity)
To make Dialer match intended staff notification behavior end-to-end:

1. **Subscribe on login/session ready**
   - Request notification permission.
   - Create/get `PushSubscription` from service worker.
   - `POST /api/pwa/subscribe` with:
     - `endpoint`
     - `keys.p256dh`
     - `keys.auth`
     - `deviceType` (`mobile` or `desktop`)

2. **Unsubscribe on logout**
   - If a subscription exists, call `DELETE /api/pwa/unsubscribe` with `endpoint`.

3. **Hydrate in-app list from server**
   - Poll or fetch `GET /api/pwa/notifications` when opening notifications panel and periodically while authenticated.
   - Render using server `id` so ack targets the right row.

4. **Ack read events to server**
   - On notification open/read action, call `POST /api/pwa/notifications/:id/ack`.
   - Optimistically mark as read in local state; reconcile with server result.

5. **Use runtime gate**
   - Read `GET /api/pwa/runtime` to determine whether push is enabled before prompting subscription UX.

6. **Optional health/admin diagnostics**
   - Admin-only checks can call `GET /api/pwa/health` to debug infrastructure readiness.

## 5) Verification commands run
Commands executed in Staff-Server to locate source-of-truth paths:
- `grep -nF '"/notifications"' src/routes/pwa.ts`
- `grep -nF '"/subscribe"' src/routes/pwa.ts`
- `grep -nF '"/unsubscribe"' src/routes/pwa.ts`
- `grep -nF "createPwaNotificationAudit" src/repositories/pwa.repo.ts`
- `grep -nF "listPwaNotificationsForUser" src/repositories/pwa.repo.ts`
- `grep -nF "acknowledgePwaNotification" src/repositories/pwa.repo.ts`
- `grep -nF "sendNotification" src/services/pushService.ts`
- `grep -nF "createPwaNotificationAudit" src/services/pushService.ts`
- `grep -RIn --exclude-dir=dist -F "Test notification" src/routes`
- `sed -n '1,120p' src/routes/_int/pwa.ts`
