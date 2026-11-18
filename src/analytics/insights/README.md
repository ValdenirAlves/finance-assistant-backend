# Monthly financial insights (on demand)

GET /analytics/insights returns FinancialInsight[]; GET /analytics/insights/summary returns {critical, warning, info} counts for the same filtered list. Optional query parameters: currency (EUR/BRL), category (ExpenseCategory), severity (INFO/WARNING/CRITICAL), type (InsightType). Unknown keys/values return 400. There is no user-supplied effective-date parameter. An empty successful result is [] (summary counts zero). Dependency failures propagate; they are never treated as no alerts.

Controlled types: BUDGET_AT_RISK, BUDGET_EXCEEDED, CATEGORY_SPEND_SPIKE, RECURRING_EXPENSE_INCREASE, MONTH_OVER_MONTH_INCREASE. Results contain deterministic id, type, severity, original currency, an English backend title and typed data with evidence. Category labels use existing display mapping. The AI explains the data in the user's language; backend titles do not require the model to derive anything.

InsightsService composes AnalyticsService.byCategory/currentDate, BudgetsService.status and RecurringExpensesService.analyze. InsightsModule imports analytics/budgets without making the underlying analytics module depend on budgets (avoids a module cycle). No Prisma access in InsightsService or AI, no persisted insights/schema changes. Voice still calls the existing AiService.

One server UTC timestamp is captured per request using the existing testable AnalyticsService.currentDate. Budget status/spending pace receive that internal date too. Current range: first UTC day of the current month through the full effective UTC day. Prior range: first day of previous month through the same day number, clamped to prior month's end. Each response comparison includes both windows. Never compare partial current month with a full previous month. No percentage insight when the prior amount is zero.

Rules:
- Current-month budgets only: OVER_BUDGET yields BUDGET_EXCEEDED/CRITICAL and suppresses risk for that budget. Otherwise projectedOverBudget yields BUDGET_AT_RISK/WARNING. Budget figures/overages come from BudgetsService; no duplicated budget arithmetic in insights.
- CATEGORY_SPEND_SPIKE: same category and currency, prior >0, increase >=20.00 AND percentage >=30%. WARNING below 50%, CRITICAL >=50%.
- MONTH_OVER_MONTH_INCREASE: total category spending per currency across equivalent periods, prior >0, increase >=50.00 AND percentage >=25%. WARNING below 50%, CRITICAL >=50%.
- RECURRING_EXPENSE_INCREASE: latest charge is in current MTD; full pattern is an accepted HIGH/MEDIUM recurrence, with at least three prior recurring occurrences and prior amount variation <=10%. Compare latest amount with unrounded prior average. Increase must be >=1.00 AND >=10%; severity WARNING. LOW/high-variance histories are excluded; this conservative rule may miss large genuine price changes that invalidate stable recurrence. Recurrence evidence comes from existing detection; no merchant-name inference.

All financial differences, percentages and thresholds use Decimal precision 40. Round monetary/percentage outputs to two-place strings only after decisions. EUR/BRL are independent. INFO is supported in the contract; none of the initial five rules emits INFO. No fixed-currency conversion is implied by minimum absolute thresholds.

Sort: CRITICAL, WARNING, INFO, then deterministic id (type followed by scope/currency identity). Exceeded and at-risk never coexist for the same budget; category spike and budget risk can coexist because they express different facts. Category filter includes only directly category-scoped insights: category budgets, category spikes and recurring groups; it excludes overall currency comparisons and merchant-only budgets. Currency/type/severity filters apply to each output independently.

Alerts mean records calculated on request. No cron, push, email, SMS, notification delivery, cancellation or background jobs. No AI-driven thresholds or financial advice when no insights exist. Automated tests fix UTC date and mock external services/database; no real OpenAI calls.
