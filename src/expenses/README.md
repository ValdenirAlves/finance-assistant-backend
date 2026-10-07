# Expenses API

`POST /expenses` accepts `amount` as a positive decimal **string**, e.g.
`"12.50"`, `currency` as `"EUR"` or `"BRL"`, and `transactionDate` as an ISO 8601
date or timestamp. Prefer timestamps with an explicit timezone, e.g.
`"2026-10-07T12:00:00Z"`. `description` and `merchant` are optional strings
and may be null. Omitted values are stored as null. Unknown body fields are rejected.

Amounts allow up to 15 integer digits and 4 fractional digits, matching
`DECIMAL(19,4)`. JSON numbers, zero, negative values, exponent notation and excess
precision are rejected with HTTP 400 rather than rounded. The service constructs
Prisma Decimal from the string and returns amounts as strings with four decimal
places, e.g. `"12.5000"`. Original currencies are preserved without conversion.

Creation returns HTTP 201 and the created expense. `GET /expenses` returns HTTP
200 and an array ordered by transactionDate descending, with no aggregation.
`GET /expenses/:id` returns HTTP 200 or 404 for an unknown UUID. Malformed UUIDs
return HTTP 400. Timestamps are serialized as ISO strings in HTTP responses.

Apply the committed migrations with `npm run prisma:deploy` before starting the
application. Endpoint e2e tests exercise real NestJS routing, validation and
services with a mocked Prisma provider; they do not verify live PostgreSQL storage.
