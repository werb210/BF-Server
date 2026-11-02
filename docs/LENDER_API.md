# Lender API connections (BF_SERVER_v873_LENDER_API)

Ported from KS-server #53 without the plan gate. An Admin connects a lender's broker API in
Lenders > edit lender > Connection, with Boreal's own broker API key or portal credentials. Then:

- **Send**: a selected lender whose connection is on and set to "send packages by API" gets the package through its
  connector instead of the email. If the API refuses or cannot be reached and email fallback is on (the default), the
  package goes by Boreal's normal email package straight away and the log says so. Without fallback, retryable
  failures are retried 5 times (2, 4, 8, 16 minutes ...). A lender with no connection, or a connection that is off,
  is sent exactly as before (email, Google Sheet, or the old `submission_method = api` envelope).
- **Submit by API** on the application's Lenders tab sends to one lender on demand (same holds as a normal send:
  signed application, SBA forms, fraud hold, product questions, dispatch lock).
- **Status back**: the lender's webhook (`POST /api/lender-webhooks/<connection id>/<secret>`, plus HMAC / shared
  secret / Salesforce organization id) or polling every N minutes (default 30) updates the file: status timeline,
  the lender's offers in the Offers list, conditions and document requests, funded amount. A status mapped to a stage
  moves the file (by default only an offer, to Offer). The assigned staff member (else every Admin in the file's
  silo) is notified.
- **Funding conditions checklist** (v865): each condition or document request a lender reports is added once to the
  file's funding conditions (source "lender_api", owned by staff; a document request is marked as needing a
  document). An item with the same title already on the checklist is linked instead. When the lender reports it
  satisfied or waived, the open checklist item is cleared or waived to match.
- **Balances after funding** (v866): polling does not stop at Funded. A funded deal is polled once a day so the lender
  can report the outstanding balance (`balance_path` / `balance_as_of_path` on a REST connection, `balance_field` /
  `balance_as_of_field` on Salesforce, or the same names in a webhook). Each new figure is recorded on the file's open
  Active Contract with `recordLenderReportedBalance` (source "lender portal"). Polling stops when every contract on
  the file is paid out, refinanced, matured or closed, or when the lender declines or withdraws the deal.
- Every change is in `lender_api_events` (the timeline, Admin log at `GET /api/lender-connections/log`) and the audit
  log (`lender_api_*` events).

## Connectors (`src/lenderConnectors/connectors`)

| Connector | Use for | Status |
|---|---|---|
| `generic_rest` | Any lender with a JSON broker API: field mapping, response paths, optional webhooks | Available |
| `salesforce` | Lenders whose broker portal is Salesforce Experience Cloud (`*.my.site.com`): OAuth at the site, sObject create, ContentVersion files, SOQL for offers/conditions, Outbound Messages or Flow callouts | Available |
| `heron` | Funders taking broker deals through Heron Data (`bft_` broker key); submit + files only (Heron documents no broker status read-back) | Available |
| `merchant_growth` | Salesforce preset shaped from Merchant Growth's broker portal (merchantadvance.my.site.com) | **Awaiting Merchant Growth's API docs** (`MERCHANT_GROWTH_API_DOCS_RECEIVED = false`): never sends; email + Google Sheet continue |

No lender endpoint is invented: the REST and Salesforce connectors only call the addresses and field names an Admin
enters from the lender's own documentation.

## Set-up

- `LENDER_CREDENTIALS_ENCRYPTION_KEY` on BF-Server (Azure App Service setting): 32 random bytes as base64
  (`openssl rand -base64 32`) or 64 hex characters. Credentials are sealed with AES-256-GCM under it; without it the
  Connection tab can be filled in but credentials cannot be saved. Changing the key means re-entering every lender's
  credentials. Keep it out of logs and chat.
- `PUBLIC_BASE_URL` (already used by payments) sets the webhook address shown to the Admin; the default is
  https://server.boreal.financial.
- Lender addresses go through the SSRF guard: HTTPS only, public hosts only, checked again at connect time.

## Turning Merchant Growth on

When Merchant Growth sends documentation and API access: correct `MERCHANT_GROWTH_PRESET` (object and field API
names, status names) in `connectors/merchantGrowth.ts`, set `MERCHANT_GROWTH_API_DOCS_RECEIVED = true`, and update
the tests. If access comes sooner, the plain `salesforce` connector can be used with the fields mapped by hand.
