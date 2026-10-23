# SellerBot Server

**Instagram DM automation backend for catalog conversations and order capture.**

SellerBot (InstaSell AI in the source) connects Instagram webhooks, an Anthropic-powered conversation handler, and a Supabase catalog. This repository contains the Node.js server, not a complete seller dashboard.

## Included capabilities

- Webhook verification and incoming Instagram message handling.
- Catalog-aware replies and product-photo delivery.
- Buyer preferences, conversation history, and order capture.
- Opt-out and human-handoff handling.
- Order, product, category, dashboard, and activity HTTP routes.
- Health endpoints at `/` and `/health`.

## Stack

Node.js · Express · Anthropic SDK · Supabase JS · Axios

## Run locally

Use Node.js 18 or later, as declared in `package.json`.

```sh
git clone https://github.com/Prathamg042004/sellerbot-server.git
cd sellerbot-server
npm install
npm start
```

Set these environment variables in your shell or hosting provider **before starting**. The application does not load a `.env` file automatically.

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Server-only database key; never expose in a frontend |
| `ANTHROPIC_API_KEY` | Server-side model access |
| `VERIFY_TOKEN` | Your webhook verification token |
| `APP_SECRET` | Meta application secret for webhook signatures |
| `PAGE_ACCESS_TOKEN` | Optional startup Instagram account check |
| `PORT` | HTTP port; defaults to 3000 |

Database access uses the `sellerbot` schema. Existing tables, views, and RPC functions are required; migrations are not included here. A fresh Supabase project alone is insufficient. Seller Instagram tokens and catalog records must also be configured.

## Request flow

1. Instagram sends an event to `POST /webhook`.
2. The server checks the signature when `APP_SECRET` is configured and acknowledges receipt.
3. The handler resolves the seller, buyer, conversation, and catalog.
4. The model produces a reply; helpers send text/photos and capture order data.
5. Conversation and activity records are written to Supabase.

## Integration status

This is an integration prototype. Meta permissions, webhook configuration, provider credentials, and an existing database are required for real conversations. A successful health check confirms the HTTP process is running; it does not verify the complete Instagram-to-database flow.

The management routes need authentication, seller-scoped authorization, and input validation before public exposure. Configure `APP_SECRET`: signature checks are conditional in the current source. Durable queues, retries, webhook deduplication, schema migrations, and automated integration tests remain follow-up work.

## Repository map

| File | Role |
| --- | --- |
| `server.js` | Webhooks, DM handling, catalog helpers, order capture, and endpoints |
| `package.json` | Dependencies and start commands |

Use `npm start`; the current `dev` script references `server-v2.js`, which is not included.

## Development priorities

- Commit reproducible database migrations and synthetic fixtures.
- Protect management endpoints with per-seller authorization.
- Validate generated order fields before changing inventory.
- Add idempotent webhook processing and integration tests.
- Split the server into route, service, and persistence modules.

## Maintainer

[Pratham Gupta](https://github.com/Prathamg042004)
