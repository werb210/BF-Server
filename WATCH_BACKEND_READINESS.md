# Apple Watch backend readiness

## Implemented

The standalone Boreal Dialer Watch backend is implemented in BF-Server without
changing the existing iPhone `/api/voice/token` contract.

| Capability | Route |
| --- | --- |
| Create an iPhone-authenticated enrollment code | `POST /api/watch/auth/enrollment` |
| Exchange a one-time code | `POST /api/watch/auth/link` |
| Rotate a Watch refresh token | `POST /api/watch/auth/refresh` |
| Register/update the linked device | `PUT /api/watch/devices/:deviceId` |
| Register/rotate standard Watch APNs | `PUT /api/watch/devices/:deviceId/push-token` |
| Delete standard Watch APNs | `DELETE /api/watch/devices/:deviceId/push-token` |
| Search silo-authorized contacts | `GET /api/watch/contacts` |
| Read owner/line-scoped recent calls | `GET /api/watch/calls/recent` |
| Create a callback bridge | `POST /api/telephony/watch/calls` |
| Recover bridge status | `GET /api/telephony/watch/calls/:callId` |
| Cancel a bridge | `DELETE /api/telephony/watch/calls/:callId` |
| Configure incoming fallback | `PUT /api/watch/devices/:deviceId/standalone-routing` |
| Revoke device/session | `DELETE /api/watch/devices/:deviceId/session` |

Watch access tokens are short lived and use a Watch-only signing key/audience.
Refresh secrets and one-time codes are stored only as SHA-256 hashes; refreshes
rotate the secret. Device, push, call, and line ownership are checked on every
request. APNs tokens are encrypted at rest and logs/responses never contain the
token. Revocation removes push registration, disables routing, invalidates all
device sessions, and attempts to cancel non-terminal provider calls.

Call creation requires `Idempotency-Key`. A repeat with the same normalized
payload returns the original bridge; a changed payload conflicts. The callback
number comes exclusively from `users.verified_callback_number` with a non-null
`callback_verified_at`. Provider callbacks alone advance a call to `connected`,
and each accepted transition increments `version`.

Incoming precedence preserves the existing call architecture: a fresh,
available Boreal VoIP identity is dialed first. Only when it is not reachable,
an active opted-in Watch exists, and the staff callback remains verified does
reception dial the cellular fallback. It is never parallel-dialed with VoIP.

Ordinary Watch notifications use standard APNs registrations only. The dispatch
API allowlists MESSAGE, TASK, MEETING, and MISSED_CALL categories and constructs
minimal payloads rather than forwarding arbitrary CRM/application data.

## Manual production configuration still required

- Apple Watch App ID
- Watch standard APNs credentials (never PushKit)
- production Apple Developer account
- `WATCH_JWT_SECRET` and `WATCH_PUSH_ENCRYPTION_KEY` in the production secret store
- Twilio production credentials and public webhook URL
- verified staff cellular callback numbers and verification timestamps
- the four `WATCH_APNS_*` application settings documented below
- physical cellular Apple Watch testing, including iPhone-unreachable scenarios

No APNs key, certificate, Twilio secret, JWT secret, database credential, or
other production credential belongs in this repository.


## Standard Apple Watch APNs delivery (manual Azure configuration)

BF-Server sends Apple Watch notifications directly through Apple's standard alert APNs HTTP/2 API. This is separate from the iPhone PushKit/Twilio Voice path and never uses the `voip` push type.

Configure these **manual deployment settings** in the production Azure App Service:

```text
WATCH_APNS_TEAM_ID=<Apple Team ID>
WATCH_APNS_KEY_ID=<APNs Key ID>
WATCH_APNS_PRIVATE_KEY=<contents of the Apple APNs signing key>
WATCH_APNS_BUNDLE_ID=financial.boreal.dialer.watchkitapp
```

`WATCH_APNS_PRIVATE_KEY` must be stored as an Azure App Service secret/application setting. Both literal newlines and Azure-style escaped `\n` newlines are supported. Do not commit an Apple `.p8` file or paste a real signing key into source code, documentation, logs, or health endpoints. The expected production APNs topic is `financial.boreal.dialer.watchkitapp`, while the environment variable remains authoritative so deployments can be validated and configured explicitly.

If all four settings are absent, Watch delivery is disabled with a `watch_apns_not_configured` startup warning. A partial production configuration is fatal and reports only the names of missing settings.
