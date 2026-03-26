# Staff Server

## Local setup

1. Install dependencies:
   ```bash
   npm ci
   ```
2. Create a `.env` from `.env.example` and fill in required values.
3. Run migrations:
   ```bash
   npm run build
   node dist/migrationsCheck.js
   ```
4. Start the server:
   ```bash
   npm start
   ```

## Required environment variables

The service expects these to be set (see `.env.example`):

- `NODE_ENV`
- `DATABASE_URL`
- `JWT_SECRET`
- `JWT_REFRESH_SECRET`
- `BUILD_TIMESTAMP`
- `COMMIT_SHA`

Additional configuration is optional but recommended (rate limits, lockout policy, token expirations).

## API Contract (Critical)

### Auth
- `POST /auth/otp/start`
- `POST /auth/otp/verify` → `{ token }`

### Telephony
- `GET /telephony/token` → `{ token }`

### Health
- `GET /health` → `{ ok: true }`

## Common commands

- `npm run build` – compile TypeScript into `dist/`
- `npm test` – run Vitest test suites
- `npm run migrate:check` – validate migrations and schema
- `npm start` – run the compiled server

## Azure App Service startup

Configure the App Service startup command to run the Node server entrypoint directly:

```bash
node dist/server/index.js
```

Avoid static-site startup modes (such as `serve`, blank startup commands, or SPA defaults) so
`/api/*` requests are handled by the Node server.

## Health endpoints

- `GET /api/_int/health` – liveness (process up)
- `GET /api/_int/ready` – readiness (env + database connectivity)
- `GET /api/_int/version` – build and schema version info

## Client submission flow (Phase 5)

Client applications can be submitted without authentication:

- `POST /api/client/submissions`
- `POST /api/client/documents` (alias: `/api/client/documents/upload`)

Payloads must include `submissionKey`, `productType`, `business`, `applicant`, and `documents`.
Submissions are idempotent by `submissionKey`, persist applications in `DOCUMENTS_REQUIRED`, and attach documents
as version 1 for each document type. Invalid or incomplete payloads are rejected.

## Lender transmission lifecycle (Phase 5)

Staff submit applications for lender transmission via:

- `POST /api/lender/submissions`

On success, submissions are logged with lender-specific payload mappings and the application
transitions to `OFF_TO_LENDER`. Failures record lender responses and move the pipeline to
`DOCUMENTS_REQUIRED` (retryable) or `DECLINED` (non-retryable) with reason codes.

Admin visibility and controls:

- `GET /api/admin/applications/:id/transmission-status`
- `POST /api/admin/transmissions/:id/retry`
- `POST /api/admin/transmissions/:id/cancel`

## Retry behavior

Failed lender submissions create retry state with exponential backoff and a maximum retry count.
Manual retries can be triggered via admin endpoints and are fully audited.

## Portal admin helpers

- `POST /api/portal/applications/:id/promote` – promote to the next valid stage (requires `reason`)
- `POST /api/portal/applications/:id/retry-job` – force retry of the latest failed processing job
- `GET /api/portal/applications/:id/history` – application stage history (supports pagination + filters)
- `GET /api/portal/jobs/:id/history` – processing job history (supports pagination + filters)
- `GET /api/portal/documents/:id/history` – document status history (supports pagination + filters)

## Audit history views

Read-only history views back the portal endpoints:

- `application_pipeline_history`
- `document_status_history`
- `processing_job_history`

## Business intelligence reporting

Admin-only reporting endpoints are available under `/api/reporting`:

- `GET /api/reporting/pipeline/summary`
- `GET /api/reporting/pipeline/timeseries`
- `GET /api/reporting/lenders/performance`
- `GET /api/reporting/applications/volume`
- `GET /api/reporting/documents/metrics`
- `GET /api/reporting/staff/activity`

BI aggregation jobs can be controlled via:

- `BI_JOBS_ENABLED` (default: enabled in production, disabled in test)
- `BI_DAILY_JOB_INTERVAL_MS`
- `BI_HOURLY_JOB_INTERVAL_MS`

## OCR pipeline

OCR jobs can be queued and reviewed via admin endpoints:

- `POST /api/admin/ocr/documents/:documentId/enqueue`
- `POST /api/admin/ocr/applications/:applicationId/enqueue`
- `GET /api/admin/ocr/documents/:documentId/status`
- `GET /api/admin/ocr/documents/:documentId/result`
- `POST /api/admin/ocr/documents/:documentId/retry`

Disable OCR by setting `OCR_ENABLED=false` or by enabling the OCR kill switch
(`OPS_KILL_SWITCH_OCR=true` or `POST /api/admin/ops/kill-switches/ocr/enable`).

## Additional environment variables

- `CLIENT_SUBMISSION_RATE_LIMIT_MAX`
- `CLIENT_SUBMISSION_RATE_LIMIT_WINDOW_MS`
- `CLIENT_SUBMISSION_OWNER_USER_ID`
- `DOCUMENT_ALLOWED_MIME_TYPES` (comma-separated)
- `DOCUMENT_MAX_SIZE_BYTES`
- `LENDER_RETRY_BASE_DELAY_MS`
- `LENDER_RETRY_MAX_DELAY_MS`
- `LENDER_RETRY_MAX_COUNT`
- `ENABLE_RATE_LIMITING` (default: true)
- `ENABLE_AUDIT_HISTORY` (default: true)
- `ENABLE_RETRY_POLICY` (default: true)
- `ENABLE_IDEMPOTENCY` (default: true)
- `OCR_ENABLED` (default: true)
- `OCR_PROVIDER` (default: openai)
- `OCR_TIMEOUT_MS`
- `OCR_MAX_ATTEMPTS`
- `OCR_WORKER_CONCURRENCY`
- `OCR_POLL_INTERVAL_MS`
- `OPENAI_API_KEY`
- `OPENAI_OCR_MODEL`

## Ops Control Plane

Admin-only ops control plane endpoints live under `/api/admin/ops`:

- `GET /api/admin/ops/kill-switches`
- `POST /api/admin/ops/kill-switches/:key/enable`
- `POST /api/admin/ops/kill-switches/:key/disable`
- `POST /api/admin/ops/replay/:scope`
- `GET /api/admin/ops/replay/:id/status`

Example: list kill switches

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8080/api/admin/ops/kill-switches
```

## Replay Procedures

Supported replay scopes are `audit_events`, `lender_submissions`, and `reporting_daily_metrics`.

Start a replay:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:8080/api/admin/ops/replay/audit_events
```

Check status:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8080/api/admin/ops/replay/{replayJobId}/status
```

## Data Export Procedures

Admin exports are served under `/api/admin/exports` and accept a JSON payload with optional
`from`, `to`, `pipelineState`, `lenderId`, `productType`, and `format` (`json` or `csv`).

Pipeline summary export (JSON):

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"from":"2024-01-01","to":"2024-02-01","format":"json"}' \
  http://localhost:8080/api/admin/exports/pipeline
```

Lender performance export (CSV):

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"lenderId":"default","format":"csv"}' \
  http://localhost:8080/api/admin/exports/lenders
```

Application volume export (CSV):

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"productType":"term_loan","format":"csv"}' \
  http://localhost:8080/api/admin/exports/applications
```

## Backfill utility

Recompute pipeline and processing stages for legacy applications:

```bash
tsx scripts/backfillApplications.ts --dry-run --verbose
```

## Emergency Kill Switches

Kill switches can be toggled through the ops control plane or enforced via environment
variables (all default to `false`):

- `OPS_KILL_SWITCH_REPLAY`
- `OPS_KILL_SWITCH_EXPORTS`
- `OPS_KILL_SWITCH_LENDER_TRANSMISSION`
- `OPS_KILL_SWITCH_OCR`

Enable the exports kill switch:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:8080/api/admin/ops/kill-switches/exports/enable
```

Disable the exports kill switch:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:8080/api/admin/ops/kill-switches/exports/disable
```

Internal introspection (no auth):

```bash
curl http://localhost:8080/api/_int/ops
```

## Production safety defaults

- Request body limit is locked to `1mb` in the server bootstrap.
- Security headers are enabled globally via `helmet()`.
- CORS is restricted to configured allow-listed origins (`CORS_ALLOWED_ORIGINS`).
- Database pools are capped to avoid connection exhaustion.

### Health check enforcement (example)

```yaml
healthcheck:
  path: /healthz
  interval: 30s
```

### Pre-scale load test

Run this before promoting to production:

```bash
autocannon -c 50 -d 20 http://localhost:3000/api/leads
```
