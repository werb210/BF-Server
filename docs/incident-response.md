# Incident Response (Minimum Runbook)

## IF API DOWN

1. **Check logs first**
   - Inspect application and infrastructure logs for startup, DB, and 5xx spikes.
2. **Check database health**
   - Validate DB connectivity and recent migration status.
3. **Rollback deploy**
   - Revert to the previous known-good release/commit.
4. **Restart service**
   - Restart API pods/processes after rollback and confirm `/healthz` returns `200`.

## Baseline Monitoring

Track and alert on:
- requests/sec
- error rate
- latency (p95 and p99)

## Escalation

- If unresolved after 15 minutes, page on-call engineering lead.
- If unresolved after 30 minutes, escalate to incident commander.
