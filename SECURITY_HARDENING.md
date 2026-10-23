# Security hardening

This branch requires APP_SECRET for webhook signatures and VERIFY_TOKEN for webhook verification. It no longer uses a publicly known verification-token default.

All /api management routes require Authorization: Bearer <ADMIN_API_TOKEN>. Configure an independent random server-operator token of at least 32 characters. This is administrator access across sellers, not a tenant login system. Never put this token in a public frontend.

Configure SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY, APP_SECRET, VERIFY_TOKEN, and ADMIN_API_TOKEN in the server environment. Secrets are not loaded from a .env file automatically.

Order updates accept only a supported status. Model-generated orders must match catalog, price, size, stock, and delivery constraints. Pending-payment candidates do not decrement stock; add a transactional reservation/payment flow before enabling automated inventory changes.

Chat and order payloads are no longer printed in the changed logging statements. Human handoff targets the current buyer's conversations rather than every conversation for a seller.

## Validation

Run `node --test security.test.cjs`. Five dependency-free regressions cover fail-closed management access, bearer tokens, webhook signatures, default verification tokens, and order mass assignment.

## Remaining work

Add tenant authentication, database migrations/RLS verification, unique webhook IDs, durable jobs/retries, a transactional order workflow, retention controls, and end-to-end tests using a disposable database and Meta test account. Existing browser dashboards must use an authenticated server layer; they must not receive the operator token.

A live health response alone does not validate these integrations.
