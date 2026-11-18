# Expenses API

`POST /expenses` accepts `amount` as a positive decimal **string**, e.g.
`"12.50"`, `currency` as `"EUR"` or `"BRL"`, and `transactionDate` as an ISO 8601
date or timestamp. Prefer timestamps with an explicit timezone, e.g.
`"2026-10-07T12:00:00Z"`. `description` and `merchant` are optional strings
and may be null. Omitted values are stored as null. Unknown body fields are rejected.

Amounts allow up to 15 integer digits and 2 fractional digits, stored in
`DECIMAL(19,2)`. JSON numbers, zero, negative values, exponent notation and excess
precision are rejected with HTTP 400 rather than rounded. The service constructs
Prisma Decimal from the string and returns amounts as strings with two decimal
places, e.g. `"12.50"`. Original currencies are preserved without conversion.

Creation returns HTTP 201 and the created expense. `GET /expenses` returns HTTP
200 and an array ordered by transactionDate descending, with no aggregation.
`GET /expenses/:id` returns HTTP 200 or 404 for an unknown UUID. Malformed UUIDs
return HTTP 400. Timestamps are serialized as ISO strings in HTTP responses.

`GET /expenses` accepts optional, combinable `currency`, `merchant`, `from` and
`to` query parameters. Currency must be `EUR` or `BRL`. Merchant matches literal
partial text case-insensitively. Dates must be valid ISO 8601 dates or timestamps
and filter `transactionDate`. Date-only bounds use UTC: `from` includes the start
of the day and `to` includes the entire day. Timestamp bounds are inclusive.
For timestamps, use an explicit timezone for consistent results across servers.
Invalid filters, unknown parameters, repeated parameters, and a start after the
end return HTTP 400. Results retain descending transactionDate order and original
amounts/currencies, with no pagination, totals, or conversion.

Example: `/expenses?currency=EUR&merchant=Tesco&from=2026-10-01&to=2026-10-31`.

Apply the committed migrations with `npm run prisma:deploy` before starting the
application. Endpoint e2e tests exercise real NestJS routing, validation and
services with a mocked Prisma provider; they do not verify live PostgreSQL storage.

Categories: every Expense and PendingExpense stores a required ExpenseCategory enum: GROCERIES, RESTAURANTS, TRANSPORT, FUEL, UTILITIES, RENT, SUBSCRIPTIONS, HEALTH, PETS, SHOPPING, ENTERTAINMENT, OTHER. POST accepts an optional enum suggestion; stored merchant mappings take precedence. Merchant normalization is trim + lowercase, exact mapping only. Unknown manual expenses default to OTHER. GET category filtering combines with existing currency/merchant/date filters. API category values remain enum codes; chat review uses deterministic Portuguese/English labels.

New expenses require `payer: "SELF" | "SPOUSE"`; an omitted, null or unsupported final payer returns 400. Pending AI drafts may have null payer while asking for clarification. The model cannot silently choose SELF. Payment method is deferred. Historical rows keep null payer and are never debited retroactively.

SELF creation atomically decrements the SELF account of the exact same currency and inserts the expense. Without that account, the entire operation returns 400 and leaves no expense or balance change; set and confirm the matching balance first. Negative resulting balances are allowed (no overdraft policy is introduced). No implicit zero account, conversion or cross-currency debit exists. SPOUSE creates the expense without reading/mutating accounts.

Pending confirmation includes creation/debit, category learning and confirmed state in the same transaction. Conversation locking and the saved expenseId make repeat confirmation/override idempotent. An intentional duplicate requires the existing explicit duplicate override and creates one additional expense/debit, once. Manual POST /expenses is an explicit creation request, not a pending confirmation endpoint; like before, repeating manual POST is a separate creation.

Both payers continue counting toward merchant/category totals, budgets, spending pace, recurring analysis and insights; payer is not an analytics exclusion filter. Responses never include bank balances. See [bank accounts](../bank-accounts/README.md).
