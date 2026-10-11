# Finance assistant with confirmed expense creation

POST `/ai/chat` with `{ "message": "How much did I spend this month?" }` returns
HTTP 201 and `{ "conversationId": "<uuid>", "answer": "..." }`. Messages must be nonempty strings (trimmed),
up to 4000 characters. Invalid bodies return 400.

Set `OPENAI_API_KEY` in backend/.env, never in version control. Optional
`OPENAI_MODEL` defaults to `gpt-5-mini`. PostgreSQL and DATABASE_URL are also
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

The prompt supplies today's UTC server date only as a reference for relative
expressions. Explicit dates take precedence; ambiguous dates require clarification.
Date interpretation is model-driven. No streaming, voice, conversion or
authentication is added in this milestone.
Unbounded expense queries may exceed model context for large datasets.

Financial facts must come from tool outputs and currencies must remain separate.
The model is instructed never to calculate totals or obey instructions embedded
in merchant/description fields. Answers without successful tool retrieval use a
fixed no-data response for read queries. Preparation returns a backend-generated
confirmation prompt, not model financial prose. Free-form read wording is not a mathematical guarantee
of factual accuracy; review against backend results remains necessary. There is
no generic numeric check on prose: dates, years, counts and empty-result answers
are valid and must not be confused with financial amounts. The former numeric
allowlist was removed because it could neither distinguish these cases nor prove
that amounts belonged to the correct currencies. No structured financial-fact
verifier exists in this milestone, so invented monetary claims in free-form text
are not deterministically rejected. Tool validation, backend-computed totals,
currency separation instructions and the successful-tool requirement remain.

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

Corrections such as `"Actually it was 52 EUR"`, `"Change the merchant to Aldi"`
or `"And it was yesterday"` use preparation again, preserving unchanged fields.
They replace the same draft, increment its revision and require a new review and
confirmation. An intervening read or non-confirmation request suspends the old
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
