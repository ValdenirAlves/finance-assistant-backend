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

## Spending pace

GET /analytics/spending-pace?year=2026&month=10&merchant=Tesco&currency=EUR

Required year/month use existing validation. Optional currency is EUR/BRL; optional merchant shares the literal, case-insensitive partial search used by expenses. Response: period {year, month, effectiveDate, daysElapsed, daysInMonth, status}, merchant, results [{currency, spentToDate, dailyAverage, weeklyAverage, projectedMonthTotal}]. Both currencies are returned separately when currency is omitted. All monetary results are two-place strings.

Current month: sum from UTC month start through the full current UTC calendar day, excluding future days. daysElapsed is the inclusive day-of-month. dailyAverage = spentToDate / daysElapsed; weeklyAverage = dailyAverage * 7; projectedMonthTotal = dailyAverage * daysInMonth. Decimal precision 40; no intermediate rounding. October 13 with 252.70 EUR yields 19.44 daily, 136.07 weekly, 602.59 projected.

Past month uses full calendar length and projection equals actual total. Future month has daysElapsed 0, effectiveDate null, spentToDate "0.00", and null averages/projection; no query or division. Empty current/past results return zero figures. No currencies are combined or converted.

AnalyticsService.currentDate isolates the server UTC clock; tests fix Date. The model cannot supply an effective date or elapsed days. get_spending_pace exposes this analytics to the AI, which only explains returned values and must not calculate projections or averages.

Budget integration: SpendingPaceDto supports optional normalized exact category filter for category budgets; merchant continues using existing partial case-insensitive filtering. BudgetsService consumes these deterministic per-currency figures.

Category analytics: GET /analytics/by-category requires inclusive from/to dates and optionally category. Totals group stored enum category and original currency, not merchant names. Output order is currency then category, totals are two-place strings. Spending pace accepts category and uses the same stored enum filter. The AI never manually sums merchants into category totals.

## Monthly recurrence candidates

GET /analytics/recurring-expenses and GET /analytics/recurring-expenses/summary accept optional currency, category, merchant, from, to, confidence. Existing expense filtering and date validation are reused (literal case-insensitive partial merchant search, inclusive UTC date bounds). Without date filters, all stored history is inspected, not only the current month. Restricting history can remove the evidence needed to detect a candidate.

Groups use existing trim/lowercase merchant normalization + currency + exact category. Missing merchants are skipped. A conservative candidate requires >=3 charges in consecutive UTC calendar months, with every charge within +/-5 calendar days of the group's initial billing day, clamped to that month's last day. Multiple same-month charges or a skipped month invalidate the whole group; this milestone does not extract separate billing streams from noisy merchants. Jan 31 -> Feb 28/29 -> Mar 31 is supported. Next expected date advances the last observed month with the same original billing-day anchor; it is approximate and may be in the past for an inactive pattern. Candidates are historical patterns, not proof of a currently active subscription.

Financial averages use Decimal precision 40. Variation = (maxAmount-minAmount)/unrounded averageAmount*100. HIGH: >=4 occurrences, maximum timing deviation <=2 days, variation <=10%. MEDIUM: accepted timing and variation <=30% (including three stable occurrences). LOW: accepted timing but variation >30%. Timing outside +/-5 days is not accepted. Evidence includes charge dates, intervals, maximum date deviation and amount variation percentage. Monetary outputs have two places. averageIntervalDays is UTC day intervals averaged to one decimal (date arithmetic only).

Sort: HIGH, MEDIUM, LOW, normalized merchant lexical, currency lexical, category lexical. Merchant display is the latest observed trimmed name (IDs break date ties). EUR and BRL remain separate; changing category splits groups rather than guessing compatible categories.

Summary always returns EUR and BRL. Include HIGH/MEDIUM only; LOW is excluded even when confidence=LOW was requested. Estimated total is the Decimal sum of included candidates' displayed two-place average amounts. recurringMerchantCount counts distinct normalized merchants among included candidates; highConfidenceCount counts HIGH candidate groups (a merchant may have separate category streams). An empty result returns zero totals/counts. This is an estimate, not historical total spending.

No persisted RecurringExpense or new index: Expense currently has its primary-key index; no measured query plan justifies a speculative composite index for this optional-filter scan. Detection uses selected history, sorts within groups and calculates on demand; frequent queries over large histories may require measured indexing/pagination/caching in a later milestone.

Monthly insights: GET /analytics/insights (optional currency/category/type/severity) composes budget status, comparable category MTD totals and stable recurring history. GET /analytics/insights/summary returns severity counts. See insights/README.md for exact thresholds, date clamps, Decimal precision, sort/filter semantics and limitations. Results are on-demand only; no persisted insight table or notification jobs.
