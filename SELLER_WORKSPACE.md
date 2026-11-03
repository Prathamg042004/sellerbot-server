# Seller workspace

The authenticated workspace is served by the Express backend at `/app`. The Vercel site is a clearly labelled interactive demo and links sellers to the backend for Instagram connection.

## Operations tools

- **Action centre:** prioritizes paused conversations, payment records pending for at least 48 hours since order creation, paid/processing orders awaiting dispatch, shipments without tracking, and active products with missing or low inventory (five units or fewer). Actions disappear when the corresponding record changes and the workspace reloads. This is a derived review queue, not a scheduled notification service.
- **Customers:** searches and filters customers using this shop's orders and conversations. Leads have no paid/processing/shipped/delivered orders in the loaded records; repeat buyers have at least two. Profiles expose related order notes and conversation links. CSV export respects the selected customer segment and search. Customer notes are currently stored on orders, not as separate CRM records.
- **Fulfillment:** filters paid, processing and shipped orders; searches courier and tracking references; links to persistent order status, courier, tracking and internal-note edits. CSV export respects the current view. Tracking is manually entered, not synced from a carrier.
- **Packing slips:** fetch shipping address and phone only when opening a slip, through authenticated seller-scoped `GET /app/api/orders/:id/shipping`. These fields are not added to the general workspace response or CSV. Print output excludes the surrounding workspace. Slips are not tax invoices or payment confirmations.
- **Pricing lab:** temporary per-unit scenarios including discounts, product cost, shipping, packaging and percentage fees. Contribution = discounted sale price minus the supplied costs and fees. Break-even sale price = total fixed per-unit costs / (1 - fee fraction). Taxes, overhead, returns and unlisted costs are excluded. It does not change catalog prices or the bot's bargaining floor.

Views use at most 500 recent records per section. Customer segments and sums therefore describe loaded records, not guaranteed lifetime totals. Demo edits stay in the current tab. No new paid service or database migration is required for these tools.

## Verification

Run `npm test` and `node build-dashboard.js`. Regression tests cover tenant isolation, anonymous access, hostile text escaping, customer segmentation, action conditions, fulfillment filtering, pricing boundaries and address formatting, alongside existing OAuth, webhook and order validation checks.

A real-browser visual/print review and a live Instagram inbound-to-reply test remain separate release checks. Local browser installation was unavailable in the implementation environment. Durable webhook processing/retries, payment-provider reconciliation, carrier integrations, publishing, persistent sessions and a seller knowledge centre remain outstanding.
