# Finance assistant with confirmed expense creation

Experimental realtime voice delegates through the same AiService rather than duplicating financial logic. WebRTC/session control, isolated current-turn speech, confirmation/privacy safeguards and deferred legacy cleanup are documented in [Realtime phase 1](realtime/README.md). POST /ai/voice remains available as fallback; no wake word is implemented.

Realtime phase 1.5 adds a semantic directionality filter before finance_turn.
Only accepted voice turns reach this AiService; uncertain/incidental speech is
silently dropped. Text chat, legacy voice and ask_clarification behavior are
unchanged. See the runtime documentation for privacy redaction, classifier
configuration, latency budget and limitations.

POST `/ai/chat` with `{ "message": "How much did I spend this month?" }` returns
HTTP 201 and `{ "conversationId": "<uuid>", "answer": "..." }`. Messages must be nonempty strings (trimmed),
up to 4000 characters. Invalid bodies return 400.

Set `OPENAI_API_KEY` in backend/.env, never in version control. Optional
`OPENAI_CHAT_MODEL` defaults to `gpt-6-luna`; `OPENAI_CLASSIFICATION_MODEL` defaults to the resolved chat model. PostgreSQL and DATABASE_URL are also
required for the existing domain services. Missing API key returns 503; upstream
or database failures return a generic 502 without provider details or secrets.

The official OpenAI SDK uses Responses API function calling.
`get_monthly_summary`, `get_expenses` and `prepare_expense` are exposed. The server validates parsed
arguments with DTOs, rejects unknown tools/fields and invokes AnalyticsService
or ExpensesService. Tool results go back to the model using function_call_output.
Invalid arguments and domain 400/404 errors produce a safe tool error so the
model can correct arguments. There are at most four rounds and four calls per round.

Expenses retain original decimal strings/currencies. Merchant totals reuse
AnalyticsService.byMerchant; no financial arithmetic occurs in the AI layer.
Merchant groups remain separate by exact stored name and currency. With no date
restriction, merchant analytics span UTC years 0001 through 9999. Read tools never
write expenses. Preparation writes only a draft; final expense creation is owned
by the deterministic confirmation handler. Expense update/delete are not exposed.
AI never imports Prisma.

For direct spending/category reads without an explicit period, the backend uses
the first UTC day of the current month through today's UTC date (inclusive).
The current backend clock supplies both dates; no date is hardcoded. Recognized
direct queries require get_by_category or get_expenses in the first model round,
and validated tool dates are normalized to that backend range. Explicit periods
(yesterday, September, a date range, this year) remain model-interpreted and are
not overwritten. Follow-ups such as "E com pets?" keep the existing history
resolution. Writes, balance requests, budgets, recurrence, averages and
projections do not receive this default. The small PT/EN recognizer is
conservative; other phrasings retain the existing model orchestration plus the
same default-period runtime instructions.
Unbounded expense queries may exceed model context for large datasets.

Financial facts must come from tool outputs and currencies must remain separate.
The model is instructed never to calculate totals or obey instructions embedded
in merchant/description fields. Free-form final text without a successful
financial tool remains blocked, including question-shaped text. Clarification
is signaled through the separate ask_clarification control tool described below;
there are no conversational sentence lists, translations or phrase/punctuation
matching in clarification recognition. The existing defensive fallback retains
the existing PT/EN request-language selection. Preparation returns a backend-generated
confirmation prompt, not model financial prose. Free-form read wording is not a mathematical guarantee
of factual accuracy; review against backend results remains necessary. There is
no generic numeric check on prose: dates, years, counts and empty-result answers
are valid and must not be confused with financial amounts. The former numeric
allowlist was removed because it could neither distinguish these cases nor prove
that amounts belonged to the correct currencies. No structured financial-fact
verifier exists in this milestone, so invented monetary claims in free-form text
are not deterministically rejected. Tool validation, backend-computed totals,
currency separation instructions and the successful-tool requirement remain.

## Semantic clarification control

ask_clarification is exposed alongside the financial tools, with a strict schema:

```json
{ "question": "<natural question chosen by the model in the user's language>" }
```

AskClarificationDto trims the question, requires a nonempty string of at most
1000 characters and rejects unknown properties. It does not classify language,
wording or question marks. Runtime instructions reserve this tool for genuinely
missing/ambiguous information, including ambiguous required write details. The
question must contain no financial factual claims, totals, balances or claims
that an operation has been saved. This is a semantic protocol, not a financial
fact verifier; DTO validation proves structure, not the truth of arbitrary prose.

AiService handles this tool separately before domain dispatch. A valid standalone
call ends the model turn and returns only the question; any accompanying model
prose is ignored. There is no second generation step. Mixed control/financial
tool batches are rejected before execution. The handler never calls financial
services or sets successfulTool, and applies the existing bank-balance privacy
guard to its output. Normal conversation-turn persistence still occurs; no
Expense, Budget or bank-account operation is prepared, confirmed or executed.
A rejected financial tool may be followed by this control action, but does not
become successful evidence. No clarification authorizes later financial prose.

For explicit write intents, the first tool choice is restricted to the relevant
preparation tool or ask_clarification, using allowed_tools/required; financial
writes still require the unchanged separate explicit confirmation. Direct
spending questions with the default month continue to force their read tool and
do not request period clarification. Explicit periods and category exclusions
are unchanged. POST /ai/chat and Realtime finance_turn use this same handler;
there are no Realtime-specific clarification rules.

Tests exercise varied natural Portuguese, English and Spanish questions,
structural validation, ignored accompanying prose, rejected mixed batches,
balance privacy, unverified financial claims, failed tools followed by a control
action, normal successful finance reads, ambiguous writes without preparation,
and POST/Realtime parity. OpenAI/network/database I/O are mocked in these tests.

## Category exclusions and spending-read diagnostics

get_by_category accepts excludeCategories as an optional domain array of controlled
ExpenseCategory values. In the strict OpenAI schema the field is required but
nullable: null/[] means no exclusions. Invalid enum values, non-arrays, duplicates,
invalid dates and unknown fields are rejected before querying. Analytics applies
Prisma category.notIn before Decimal summation, returning two-decimal string totals
per remaining category AND currency. If category is also supplied, equals and
notIn both apply; excluding the included category returns no matching expenses.
No schema migration, LLM subtraction or cross-currency arithmetic is introduced.

"Outros gastos" / "other expenses" as a category means OTHER only. "Além de mercado
e pets" / "excluding groceries and pets" means exclude GROCERIES and PETS, with
category=null. This can return TRANSPORT, RESTAURANTS and other remaining
categories, not just OTHER. Returned category groups are presented separately;
the model must not sum or subtract them. The shared analytics HTTP endpoint accepts
arrays using repeated query keys, e.g. excludeCategories=GROCERIES&excludeCategories=PETS.

With NODE_ENV=development, ai.spending_query diagnostics record resolved from/to,
category, excludedCategories, defaultPeriodApplied, clarificationPreserved,
financialToolSucceeded, balancePrivacyBlocked and financialSafetyFallback as applicable. They contain
no bank balances, raw answers or financial values. Realtime transport is unchanged:
finance_turn delegates to this same service and receives the same domain results.

Regression fixtures exercise 0.10 + 0.20 = "0.30" in OTHER, TRANSPORT remaining after
groceries/pets exclusions, BRL separation, explicit period preservation, fact-free
clarification preservation and blocked unverified claims/tool validation errors.
POST /ai/chat and Realtime finance_turn parity is tested through actual Nest/domain
services with mocked OpenAI and database I/O; visible text is unchanged by speech
formatting. These tests do not guarantee identical prose from separate live model
calls.

## Conversations

Omitting `conversationId` creates a new PostgreSQL conversation. Include the
returned UUID in subsequent requests. Invalid UUIDs return 400 and unknown
conversations return 404 before invoking OpenAI.

First request:

```json
{ "message": "How much did I spend at Tesco in October 2026?" }
```

Follow-up:

```json
{ "conversationId": "<returned-uuid>", "message": "And in September?" }
```

ConversationService loads the most recent **20 messages**, then supplies them in
chronological order. Older messages stay in PostgreSQL but are not sent to the
model. Completed turns are stored atomically as USER and ASSISTANT messages;
failed OpenAI turns are not stored. A new conversation can remain empty if its
first request fails. Only visible message text is persisted, never SDK objects,
tool outputs, system instructions, hidden prompts, API keys or internal reasoning.
Conversation updatedAt is refreshed when a completed turn is stored.

History provides merchant, currency and date context, never current financial
facts. Every request starts with no successful tools; old assistant text alone
cannot pass the current-turn tool requirement. Follow-up comparisons must query
each period successfully. A compared period with no matching expenses means
`0.00` in the relevant currency, not missing data. Tool errors or unavailable
data must never be treated as zero. Follow-up comparisons must query
all relevant periods again and present backend figures separated by currency;
no combined currency total or model-calculated financial difference is supported.
Language follows the current user message unless another language is explicitly
requested. Interpretation and prose remain model-driven, and mocked tests verify
orchestration rather than guaranteeing real-model intent resolution.

Clients should await each response before sending another turn on the same
conversation. Message writes are atomic and ordered, but concurrent requests can
read the same preceding context. There is no user ownership/authentication yet;
conversation UUIDs are identifiers, not an authorization mechanism.
Conversation storage failures return a generic 503 without database details.

The `20261007030000_conversations` Prisma migration adds Conversation,
ConversationMessage and ConversationRole, plus an index for recent-message lookup.
Apply it with `npm run prisma:deploy` on each environment. No new dependency or
environment variable is required.

Automated tests mock the OpenAI SDK and persistence/domain services; no real API
key or network request is needed.

Reference: https://developers.openai.com/api/docs/guides/function-calling

## Expense preparation and confirmation

Start a request such as `"I spent 45 EUR at Tesco today."` or
`"Registra 85 reais de supermercado no Carrefour."`. The model may choose
`prepare_expense`; it cannot choose a final write or confirmation tool. A spending
question such as `"How much did I spend at Tesco?"` still uses read tools.

Clear declarations with an amount/currency (the examples above, `"Add 32 EUR for
lunch"`, `"Yesterday I paid 119.90 BRL for Claro"`) force the first Responses request
to use `prepare_expense`, with parallel calls disabled. This is conservative intent
routing, not financial parsing: OpenAI still extracts the fields and domain
validation still applies. Questions are not forced into preparation. Other phrasing
and draft corrections retain model-driven tool selection. If a provider ignores
the forced function, the backend returns a safe 502 instead of the obsolete
read-only fallback or a false confirmation prompt; nothing is saved.

All draft fields pass the same DTO and domain validation as manual creation:
positive decimal string, at most two fractional digits, EUR/BRL only, valid ISO
date, optional merchant/description. Missing creation date defaults to today's
UTC date; ambiguous required fields should trigger clarification. No conversion.

Missing payer is different from ambiguous amount/currency/date. For a resolved
expense statement, including amounts expressed in words, the model must call
`prepare_expense` with `payer=null` before any payer question. The backend saves
the PENDING draft and then asks who paid. A clear semantic payer answer uses
`patch_pending_expense` immediately; it does not require an interpretation
confirmation. Once complete, the backend displays the review and asks for a
separate SAVE confirmation. Only that later explicit confirmation can create an
Expense. A genuinely ambiguous payer may use `ask_clarification`; it never clears
or replaces the persisted draft and a semantic yes cannot bypass missing payer.
No sentence lists or spoken-number parser are used for this interpretation.

An assistant question alone is not evidence of a pending draft: only successful
`prepare_expense` creates its backend state. A subsequent confirmation cannot
recover financial fields from assistant prose. Chat and Realtime share the same
AiService and conversationId; neither clarification nor assistant message storage
deletes the pending draft. No separate Realtime draft or expiration is introduced.

At the tool boundary, numeric JSON amount literals are captured as decimal
strings before JSON.parse can lose precision; strings are padded to two places
without financial Number arithmetic or rounding. Extra precision still fails
domain validation. Currency is trimmed/uppercased, and today/yesterday/hoje/ontem
resolve to concrete UTC dates before DTO validation. Explicit dates are preserved.
Omitted optional description/merchant fields remain valid. For en/pt, unused
confirmationQuestion prose is discarded before validation because the backend
owns the prompt; other languages retain the non-financial question validation.

Preparation diagnostics are off by default. Enable both `NODE_ENV=development`
and `AI_PREPARE_DEBUG=1` to log raw arguments, normalized DTO/domain input and
field constraints on the server only. Production never logs these diagnostics,
even with the flag enabled. These logs contain expense details: use locally and
disable the flag after diagnosis. HTTP errors remain generic.

PendingExpenseService persists one structured draft per conversation. It uses
PENDING, CONFIRMED and CANCELLED statuses, a revision counter, an explicit
confirmationRequested flag and an expenseId after success. Drafts are not
expenses and are excluded from spending queries/analytics. The model receives
the current structured draft independently of the 20-message history limit.

Preparation terminates the model turn with a backend-generated summary and
confirmation question, and arms confirmation only after saving that visible
prompt to conversation history. English and Portuguese preparation prompts use
backend templates. For other requested languages, the model supplies only a short
localized confirmation question, without numeric facts; the backend appends it to
the persisted amount, currency, merchant and date. Confirmation/cancellation
acknowledgements follow the language of the recognized English/Portuguese phrase.

Confirm on the same conversationId with an entire explicit phrase: `yes`,
`confirm`, `save it`, `go ahead`, `sim`, `confirma`, `confirmar`, `pode salvar`.
Case, accents, whitespace and trailing punctuation are normalized. These are
exact phrases, not substring matches: `"yes, but change it"`, `"maybe"`,
`"I think so"` and `"wait"` do not authorize a write. A valid current conversation,
current draft revision and recorded confirmation request are also required.
The model never decides final confirmation, and one initial message cannot both
prepare and save an expense. No API key/OpenAI request is needed for the final
deterministic confirmation handler.

Corrections use the semantic `patch_pending_expense` tool, not complete draft
replacement. Its contract is `{ changes: [{ field, value }], language,
confirmationQuestion }`, with only explicitly supplied fields included.
`confirmationQuestion` retains the existing localized review-question contract:
null for backend en/pt templates; non-financial localized question for other
languages. The model can update amount, currency,
merchant, description, date, category or payer in any order, regardless of the
last question. No conversational phrase list or sentence matching selects patches.
Null explicitly clears only merchant, description or payer; omission preserves
the persisted value. Merchant and description remain optional; payer is required.
The backend merges and validates under the conversation lock, increments the
revision, resets duplicate review and asks only for missing required information
or a fresh explicit save confirmation. An edit never saves an Expense. Merchant
names are free-form; changed merchants consult stored mappings before the existing
bounded category classifier, with OTHER only as its safe fallback. Explicit
category corrections must use the controlled enum. Chat and Realtime finance_turn
share this path. `prepare_expense` is for new drafts, not partial corrections.
An intervening read or non-confirmation request suspends the old
confirmation authorization. A subsequent `yes` first displays another review,
and a separate confirmation is then needed.

Cancel with `cancel`, `never mind`, `don't save it`, `no`, `cancela` or `não`.
Cancellation never creates or deletes an Expense. Confirming a cancelled draft
does not save it. Confirm/cancel without a draft return a normal no-pending
answer. Preparing again after cancellation starts a new revision.

Confirmation locks the parent conversation row and performs ExpensesService.create
and the status/expenseId update inside the **same PostgreSQL transaction**.
Sequential or concurrent repeated confirmations of the same revision return the
already-created Expense, without another insert. Stale revisions return 409.
Any creation/status-update failure rolls back both writes and leaves the draft
PENDING for retry, returning a sanitized 503. If storing the acknowledgement fails
after commit, retrying confirmation still returns the saved expense. A subsequent
new preparation reuses the draft row with a new revision; saved expenses remain.

The `20261009000000_pending_expenses` migration adds the draft model, enum,
relations and uniqueness constraints. Use `npm run prisma:deploy` before starting
this version in an existing environment. No new dependencies/environment variables.

Natural-language extraction remains model-driven; review every field before
confirming. Concurrent corrections are rejected using revision checks. Clients
should still serialize turns per conversation. This milestone has no public
draft editing endpoints, expiry, multi-draft queue, expense updates/deletes or
conversation ownership/authentication. The tests mock OpenAI and PostgreSQL,
while running the actual pending/expense domain services with transactional mocks.

Duplicate expenses: confirmed AI drafts are checked for equal Decimal amount, original currency, case-insensitive merchant and UTC calendar day (description ignored; null merchants match null). PendingExpense.duplicateReviewRequired persists the warning for the current revision. Plain yes repeats the warning. Only explicit phrases such as "Yes, save another one", "Yes, save it anyway", "Save the duplicate", "Sim, pode salvar outra" or "Pode salvar mesmo assim" authorize an intentional duplicate. Override without active duplicate review cannot save a pending draft. Edits reset duplicate review. Confirmation uses the existing conversation row lock and transaction; repeated confirmation/override returns the linked Expense instead of inserting again. Cancellation cannot be overridden. Manual expense creation now requires explicit payer as documented below.

Spending pace: use read-only get_spending_pace for daily/weekly averages and monthly projections. Required year/month; nullable currency/merchant. Backend uses current UTC day, unrounded Decimal division by daysElapsed, multiplication by 7 for weekly averages and calendar month length for projections. Past projection equals actual total; future averages/projection are null. Currency results remain separate; merchant uses existing partial case-insensitive semantics. The model must only explain returned figures. See ../analytics/README.md.

Monthly budgets: prepare_budget prepares dedicated PendingBudget state and requires separate deterministic confirmation before persistence. Exactly one merchant/category and one currency per monthly budget. get_budget_status retrieves remaining amount, percentage, threshold status and spending-pace projection from BudgetsService. Do not calculate any budget figures in the model. Resolve scope/period follow-ups from conversation history, then retrieve fresh data. Preparing a new write cancels the other domain's pending draft; corrections require confirmation again. Voice uses the same chat and speech formatting. See ../budgets/README.md.

Expense categories: mapping lookup through ExpensesService is authoritative and happens before any AI classification. Only an unknown merchant triggers a bounded Responses structured JSON classification returning one allowed enum; uncertainty/provider failure defaults to OTHER. Invalid category codes are rejected. Confirmation persists the PendingExpense category and learns an insert-if-absent merchant mapping in the same transaction. Cancellation, duplicate warning and rollback do not learn mappings. No existing mapping is silently overwritten. Category concepts (supermercado/mercado/groceries, pets/animais, assinaturas) use get_by_category, category-filtered get_spending_pace and get_budget_status. Never manually consolidate merchants. Voice uses exactly the same path.

Recurring expenses: use get_recurring_expenses for lists/evidence and get_recurring_expense_summary for estimated monthly totals. Both are read-only and accept nullable currency/category/merchant/from/to/confidence filters. Backend determines timing, amount stability, confidence and next expected date; do not infer recurrence from merchant names or conversation history. Subscription questions use category=SUBSCRIPTIONS; generic recurrence spans all categories. Recurrence and subscriptions are not synonyms. Explain MEDIUM/LOW as uncertain patterns, never guaranteed active contracts. Quote returned average amounts and dates only, never perform recurrence math. Summary includes HIGH/MEDIUM and excludes LOW. Existing voice flow passes the same chat results through speech formatting; no voice recurrence agent or actions exist.

Monthly financial insights: get_financial_insights is a read-only tool with nullable currency/category/type/severity. Use it for monthly warnings, unusual spending, budgets at risk and subscription price increases. Explain only returned backend figures and severity, prioritizing CRITICAL/WARNING/INFO; do not expose raw enum names. Empty successful results permit a normal no-relevant-alerts answer, never invented advice. Subscription-increase questions use RECURRING_EXPENSE_INCREASE + SUBSCRIPTIONS. Voice uses the same chat and existing speech formatting. See ../analytics/insights/README.md.

Budget pace follow-ups: deterministic routing recognizes reduction/daily allowance/remaining-period/weekly budget questions. Resolve the merchant/category and currency against current-month budgets using explicit user scope or only the latest relevant visible turn; history amounts are never parsed or calculated from. Multiple budgets/currencies, stale unrelated context or no target produce clarification, not generic expense fallback. The route invokes existing get_budget_status again for fresh backend guidance and uses a small fixed-language response formatter; no model inference is needed for the final financial math. Reads still disarm pending-write confirmation. No extra schema or tool is added.

For temporary exact-query timing and measured before/after results, see DIAGNOSTICS.md. The generic Portuguese monthly-insights question now executes get_financial_insights once deterministically before one OpenAI explanation request; other routing retains the existing four-round limit.

Personal bank balance: `prepare_bank_balance_update` accepts an exact signed `currentBalance` string, EUR/BRL currency and optional account name. It prepares PendingBankBalance only for an explicit current-turn balance-setting declaration. Final confirmation is deterministic, uses persisted draft/revision and is separate from preparation. Cancelled/stale drafts cannot save; repeated confirmation does not reset a balance after later expenses. Preparing a balance, expense or budget cancels competing pending write domains; unrelated turns suspend balance confirmation. A later yes first re-arms a generic review without disclosing the amount, then requires a separate confirmation.

`get_bank_balance` is a protected domain read. Only a positively recognized CURRENT balance request authorizes it. The backend handles that query deterministically and returns decimal strings by account/currency, without exposing account data to the model. General OpenAI requests omit this tool, and dispatch also rejects unauthorized calls. Prior balance messages do not grant access. Balance-setting/read/confirmation turns save redacted conversation placeholders instead of sensitive prose; any older balance-labelled context is also filtered from model input. Runtime instructions prohibit unsolicited balance disclosure; balance-labelled free-form responses on unrelated turns are withheld. No privacy check extracts arbitrary financial numbers from prose.

`prepare_expense` adds nullable `payer: SELF | SPOUSE`. Backend resolves explicit current-turn payer wording for new drafts and otherwise asks whose card/account paid. It does not trust an invented model SELF during creation. Subsequent payer clarification is interpreted semantically through `patch_pending_expense`, just like any other field, preserving all omitted persisted values. A patch creates a new revision and asks for separate confirmation; it never saves immediately. Final creation requires resolved payer. SELF debits the matching-currency account atomically; SPOUSE has zero account impact. Every expense still counts toward all analytics/budgets/recurrence/insights.

Expense/budget confirmations and generic reads never volunteer resulting bank balance. Balance confirmation says only "Saldo atualizado." / "Balance updated." Voice passes through this same AiService and speaks only the authorized answer; there is no separate voice balance logic. Account read/write API details and migration are in [Bank accounts](../bank-accounts/README.md).

OpenAI model configuration is resolved once by the injected `OpenAIConfig` provider.
`OPENAI_TRANSCRIBE_MODEL` defaults to `gpt-transcribe`, `OPENAI_TTS_MODEL` to
`gpt-4o-mini-tts`, and `OPENAI_VOICE` to `marin`. Omitted variables use these
explicit defaults; blank or malformed identifiers fail configuration validation.
Model availability and account access are checked by the provider API, not a local allowlist.
The removed `OPENAI_MODEL` variable causes a clear startup error; rename deployment
settings to `OPENAI_CHAT_MODEL`. There is no provider-error fallback model.
Historical DIAGNOSTICS.md measurements remain the original model baseline.
TTS stays on the Audio Speech API; its future migration to Realtime is a separate milestone.
