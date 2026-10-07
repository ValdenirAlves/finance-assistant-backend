# Basic expense analytics

`GET /analytics/monthly-summary?year=2026&month=10` requires a four-digit
year from 0001 through 9999 and a month from 1 through 12 (leading zero allowed).
It queries transactionDate from the first UTC instant of the month up to, but
excluding, the first instant of the next month. The response contains numeric
`period.year` and `period.month`, plus `totals.EUR` and `totals.BRL` as strings.
Both currencies are always returned; an empty currency has total `"0.00"`.

`GET /analytics/by-merchant?from=2026-10-01&to=2026-10-31` requires both bounds
as valid ISO 8601 dates or timestamps. Date-only bounds include the full UTC day;
timestamp bounds are inclusive (use explicit timezones for consistent behavior).
An inverted range returns HTTP 400, as do invalid, missing, repeated or unknown
query parameters on either endpoint.

Merchant results are grouped by the exact stored merchant name and currency.
Null merchants stay null; an empty string remains separate. Names differing in
case remain separate. Order is lexical currency (BRL, then EUR), then lexical
merchant within the currency, with null first. Totals are never compared across
currencies. An empty range returns `[]`.

Only required fields are fetched through PrismaService. Aggregation uses Decimal
addition with 40 significant digits of precision, never JavaScript Number.
Totals are formatted once after summation to two decimal places (Decimal's default
half-up rounding if legacy records have more than two fractional digits).
Original stored amounts and currencies are unchanged; no conversion occurs.

Unit and HTTP e2e tests mock Prisma and exercise the actual aggregation and
validation. They do not test live PostgreSQL connectivity. No schema migration
is needed for these endpoints.
