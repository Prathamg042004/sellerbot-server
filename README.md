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

Use Node.js 22 or later, as declared in `package.json`.

```sh
git clone https://github.com/Prathamg042004/sellerbot-server.git
cd sellerbot-server
npm ci
npm start
```

Set these environment variables in your shell or hosting provider **before starting**. The application does not load a `.env` file automatically.

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Server-only database key; never expose in a frontend |
| `ANTHROPIC_API_KEY` | Server-side model access |
| `VERIFY_TOKEN` | Your webhook verification token |
| `APP_SECRET` | Required Meta application secret for webhook signatures |
| `ADMIN_API_TOKEN` | Independent random operator bearer token, at least 32 characters; server-only |
| `PAGE_ACCESS_TOKEN` | Optional startup Instagram account check |
| `PORT` | HTTP port; defaults to 3000 |

Database access uses the `sellerbot` schema. Existing tables, views, and RPC functions are required; migrations are not included here. A fresh Supabase project alone is insufficient. Seller Instagram tokens and catalog records must also be configured.

## Request flow

1. Instagram sends an event to `POST /webhook`.
2. The server requires a valid signature using `APP_SECRET` and acknowledges receipt.
3. The handler resolves the seller, buyer, conversation, and catalog.
4. The model produces a reply; helpers send text/photos and capture order data.
5. Conversation and activity records are written to Supabase.

## Integration status

This is an integration prototype. Meta permissions, webhook configuration, provider credentials, and an existing database are required for real conversations. A successful health check confirms the HTTP process is running; it does not verify the complete Instagram-to-database flow.

Management routes require the operator bearer token. This token grants access across sellers; it is not tenant authentication and must never be embedded in a browser dashboard. Missing webhook secrets fail closed. Durable queues, retries, webhook deduplication, schema migrations, and automated integration tests remain follow-up work.

## Repository map

| File | Role |
| --- | --- |
| `server.js` | Webhooks, DM handling, catalog helpers, order capture, and endpoints |
| `package.json` | Dependencies and start commands |

Use `npm start` in production, `npm run dev` for local file watching, and `npm test` for security regressions. See [security configuration](SECURITY_HARDENING.md).

## Development priorities

- Commit reproducible database migrations and synthetic fixtures.
- Protect management endpoints with per-seller authorization.
- Validate generated order fields before changing inventory.
- Add idempotent webhook processing and integration tests.
- Split the server into route, service, and persistence modules.

## Maintainer

[Pratham Gupta](https://github.com/Prathamg042004)

## Seller connection portal

Open `/app` to start a real Instagram Business Login flow. The root URL now redirects to the portal; `/health` remains the machine health endpoint. Register this exact OAuth redirect URI in Meta's Instagram Business login settings:

`https://sellerbot-server.onrender.com/auth/instagram/callback`

The portal requests only `instagram_business_basic` and `instagram_business_manage_messages`. These belong to Instagram Login and differ from Facebook Login's `instagram_basic` / `instagram_manage_messages`; select the matching permissions in App Review.

`INSTAGRAM_APP_ID` defaults to this project's Instagram app ID (1518243673369480). `INSTAGRAM_APP_SECRET` can override `APP_SECRET`; the latter must already be the Instagram signing secret. `PUBLIC_BASE_URL` defaults to the existing Render hostname. Never expose secrets to the browser. The backend exchanges authorization codes, validates granted scopes, retrieves the verified account's `user_id`, subscribes `messages`, and stores the long-lived token in the existing server-side seller record. It preserves the catalog when the same verified Instagram account reconnects.

The dashboard uses opaque HttpOnly, SameSite cookies, expiring single-use OAuth state, origin/CSRF checks on actions, no-store responses and a restrictive CSP. Sessions are in memory, expire after eight hours, and are lost on restart. This is suitable for the existing single-instance prototype; shared durable sessions and periodic token refresh are needed before multi-instance/public scale. Tokens expire after roughly 60 days; reconnect before expiry. No secret or operator API token is embedded in the UI.

Disconnect stops automation and clears the stored token for the authenticated seller; it preserves orders, messages and products. It does not revoke Meta permissions (the UI directs the owner to Instagram Apps and websites for revocation). Signing out only ends the dashboard session. Existing non-OAuth sellers continue to use their previous token configuration unless explicitly paused.

`npm test` includes OAuth success, cancellation, expiry/replay protection, missing permissions, failed subscription, scoped persistence, disconnect and cross-origin protections with synthetic provider responses. Real provider approval and the callback must also be verified before making an App Review recording.

## Demo product images

The public dashboard includes five sample catalog cards. Files in `public/catalog/` are AI-generated illustrative demo images, labeled inside each image; they are not photographs of real stock. Catalog image URLs must point to the matching SKU on the deployed service. The image sender counts only Instagram-accepted messages and reports partial/missing delivery instead of claiming success. Default conversation language is English. A human handoff pauses the conversation without claiming an owner notification has been sent.
