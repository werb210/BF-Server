SYSTEM_CONTRACT.md

Boreal Financial – Staff Server

This document is the single source of truth governing server behavior.
No feature, endpoint, UI, or integration may contradict this contract.

⸻

1. Purpose

This contract defines immutable system rules governing:
	•	Applications
	•	Lenders
	•	Lender Products
	•	Required Documents
	•	OCR & Banking Analysis
	•	Credit Summary
	•	Sales Pipeline
	•	Commissions & Profit Share
	•	Client / Staff / Lender boundaries
	•	Internal-only data

This contract ensures:
	•	Predictable behavior
	•	Auditability
	•	No retroactive rule changes
	•	Safe extensibility

⸻

2. Core Entities

2.1 Application
	•	Represents a single funding request
	•	One client may have multiple applications
	•	Applications are immutable after lender acceptance except for lifecycle state

⸻

2.2 Lender
	•	Represents a funding institution
	•	A lender may operate in multiple countries
	•	Country availability is NOT inferred from lender HQ
	•	Lender availability is derived only from product definitions

⸻

2.3 Lender Product
	•	Atomic funding offering
	•	Defines:
	•	Funding type (LOC, term loan, factoring, startup, etc.)
	•	Country availability
	•	Required documents
	•	Commission structure
	•	Profit-share rules (if applicable)

Startup Products
	•	Startup is not a global mode
	•	Startup appears only if a lender product is explicitly marked as startup
	•	No startup flows exist without a startup-enabled product

⸻

3. Documents & Analysis

3.1 Documents
	•	Raw uploaded files
	•	Versioned
	•	Immutable once accepted by lender
	•	May be reprocessed but never deleted

⸻

3.2 Financials (OCR Output)
	•	OCR results from non-bank documents, including:
	•	Financial statements
	•	Tax documents
	•	AR/AP
	•	Stored independently of banking data
	•	Never mixed with banking analysis

⸻

3.3 Banking Analysis (OCR Output)
	•	OCR results from bank statements only
	•	Typically 3–6 months
	•	Produces:
	•	Cash flow metrics
	•	Balances
	•	NSF / overdraft indicators
	•	Trend signals
	•	Banking OCR never lives in Financials

⸻

3.4 Credit Summary (Derived Artifact)
	•	Derived, not raw
	•	Aggregates:
	•	Financials OCR outputs
	•	Banking Analysis outputs
	•	Internal scoring logic
	•	Read-only
	•	Staff-only by default
	•	Used for:
	•	Rapid underwriting review
	•	Lender Matching scoring

No direct uploads.
No client or lender visibility unless explicitly enabled in future.

⸻

4. Sales Pipeline (Application Card)

4.1 Canonical Tab Order

The application detail view must appear in this exact order:
	1.	Application
	2.	Financials
	3.	Banking Analysis
	4.	Credit Summary
	5.	Documents
	6.	Notes (internal only)
	7.	Lender Matching

No reordering is permitted without updating this contract.

⸻

4.2 Notes
	•	Internal staff ↔ staff only
	•	Never exposed to:
	•	Clients
	•	Lenders
	•	Not included in exports, APIs, or external reports

⸻

4.3 Lender Matching
	•	Uses:
	•	Credit Summary
	•	Product country availability
	•	Required document completeness
	•	Never uses lender HQ location
	•	Matching is frozen once lender accepts

⸻

5. Commissions & Profit Share

5.1 Commission Types

A. One-Time Commission
	•	Paid on close
	•	Fixed percentage of funded amount
	•	Recorded at lender acceptance
	•	Immutable after acceptance

B. Profit Share (Revenue Share)
	•	Percentage of top-line revenue
	•	Calculated over time (e.g., daily / monthly)
	•	Continues for product-defined duration
	•	Frozen at lender acceptance

Example:
Client uses X for Y days → lender charges Z → Boreal receives N% of Z

Commission percentage is independent of deal size.

⸻

6. Country Availability (Critical Fix)
	•	Country availability is defined ONLY at the lender product level
	•	Lender HQ location is irrelevant
	•	Applications are matched solely based on:
	•	Product country list
	•	Client country

⸻

7. Required Documents
	•	Required documents are defined per lender product
	•	Products may add new required document types at any time
	•	Existing applications are unaffected unless explicitly re-requested
	•	System supports:
	•	Adding new document categories
	•	New OCR pipelines
	•	New validation rules
	•	No schema rewrite required for expansion

⸻

8. Access Boundaries

Data	Client	Lender	Staff
Application	✓	✓ (limited)	✓
Documents	✓	✓ (accepted only)	✓
Financials OCR	✗	✗	✓
Banking Analysis	✗	✗	✓
Credit Summary	✗	✗	✓
Notes	✗	✗	✓
Commission Data	✗	✗	✓


⸻

9. Mutability Rules
	•	Application data freezes at lender acceptance
	•	Documents freeze per version at acceptance
	•	Commission structures freeze at acceptance
	•	Derived artifacts may refresh but must respect frozen inputs

⸻

10. Extensibility Guarantees

The system must support without breaking changes:
	•	New lender product types
	•	New required document categories
	•	New OCR pipelines
	•	New credit signals
	•	New reporting dimensions
	•	New commission models

⸻

11. Enforcement
	•	Any implementation contradicting this contract is a bug
	•	UI, API, tests, and future Codex blocks must comply
	•	Changes require an explicit contract revision

⸻


## Route Alias Behavior

Non-API paths not in the canonical allowlist (`/`, `/health`, `/ready`, `/metrics`) are intentionally rejected with `410 LEGACY_ROUTE_DISABLED` by `routeAlias`.
