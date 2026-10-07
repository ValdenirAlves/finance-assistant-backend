# Read-only finance assistant

POST `/ai/chat` with `{ "message": "How much did I spend this month?" }` returns
HTTP 201 and `{ "conversationId": "<uuid>", "answer": "..." }`. Messages must be nonempty strings (trimmed),
up to 4000 characters. Invalid bodies return 400.

Set `OPENAI_API_KEY` in backend/.env, never in version control. Optional
`OPENAI_MODEL` defaults to `gpt-5-mini`. PostgreSQL and DATABASE_URL are also
required for the existing domain services. Missing API key returns 503; upstream
or database failures return a generic 502 without provider details or secrets.

The official OpenAI SDK uses Responses API function calling. Only
`get_monthly_summary` and `get_expenses` are exposed. The server validates parsed
arguments with DTOs, rejects unknown tools/fields and invokes AnalyticsService
or ExpensesService. Tool results go back to the model using function_call_output.
Invalid arguments and domain 400/404 errors produce a safe tool error so the
model can correct arguments. There are at most four rounds and four calls per round.

Expenses retain original decimal strings/currencies. Merchant totals reuse
AnalyticsService.byMerchant; no financial arithmetic occurs in the AI layer.
Merchant groups remain separate by exact stored name and currency. With no date
restriction, merchant analytics span UTC years 0001 through 9999. No expenses can
be created, updated or deleted through these tools. AI never imports Prisma.

The prompt supplies today's UTC server date only as a reference for relative
expressions. Explicit dates take precedence; ambiguous dates require clarification.
Date interpretation is model-driven. No streaming, voice, conversion or
authentication is added in this milestone.
Unbounded expense queries may exceed model context for large datasets.

Financial facts must come from tool outputs and currencies must remain separate.
The model is instructed never to calculate totals or obey instructions embedded
in merchant/description fields. Answers without successful tool retrieval use a
fixed no-data response. Free-form model wording is not a mathematical guarantee
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
