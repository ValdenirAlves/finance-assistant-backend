# Temporary monthly-insights chat diagnostics

Enable only in development: NODE_ENV=development and AI_CHAT_TIMING=1; restart the backend so Prisma query events are enabled. Instrumentation targets the exact question "Tem algo importante nas minhas finanças este mês?" (case and trailing punctuation are normalized). Logs are JSON correlated by requestId. No answer, transcript, audio, query parameters, SQL text, credentials or financial amounts are logged. Disable AI_CHAT_TIMING after diagnosis; production never emits these diagnostic logs.

Stages: request start/total, conversation creation/history loading (history count/characters), pending-state reads, each OpenAI round with first/final markers, model/token counts, tool name/round/duration, insight loading and budget/category/month-over-month/recurring phases, conversation save, database query duration/operation/count. A stage still running after 5 seconds emits a slow marker; queries >=1000 ms are flagged slow. Total backend duration starts in AiService and excludes browser/HTTP transit and TTS. Voice timing remains separate.

Real local read-only HTTP reproductions with gpt-4.1-mini and no conversationId:

| Stage | Before run 1 | Before run 2 | After exact-query routing |
|---|---:|---:|---:|
| HTTP total | 4526 ms | 3060 ms | 1929 ms |
| First model/tool selection | 1824 ms | 1266 ms | eliminated |
| Financial insights tool | 41 ms | 52 ms | 34 ms |
| Final OpenAI answer | 2542 ms | 1595 ms | 1779 ms |
| OpenAI rounds | 2 | 2 | 1 |
| Insights executions | 1 | 1 | 1 |
| Database queries | 13 | 13 | 13 |

One current budget, twelve history expenses and one recurring candidate were inspected. Budget analysis took 8-12 ms; category, month-over-month and recurring evaluation each under 1 ms; recurrence loading 23-36 ms. Database queries were not slow. Initial independent insight loads were already parallel. Budget status has two queries per budget and remains serial, but was not the measured bottleneck, so it was not changed. Recurrence has an upper date bound and no lower history bound by design; no arbitrary history truncation was added.

The minute-long hang did not reproduce. These samples do not establish its root cause, the behavior of a different running process, or the latency of a 20-message conversation. SDK retries remain zero and timeout remains 30 seconds per model request. The existing global maximum is four model rounds (and at most four tool calls per round), not an infinite loop. A general request can still take longer than 30 seconds across multiple bounded requests and database waits.

The only optimization is deterministic routing for this exact generic monthly-insights question: invoke validated get_financial_insights once, provide the structured current-turn tool result to OpenAI, and set tool_choice=none for explanation. Financial calculations, model, history size, SQL and confirmation rules are preserved. Unexpected tool calls after prefetch fail safely instead of executing another equivalent tool.

## Existing-conversation comparison, October 14

Diagnostic records now include conversationId, processPid, requestUrl and backendPort. History records include loaded message count, UTF-8 bytes, character count and repeated message count. Pending expense/budget status and revision are logged without amounts or merchants. Enable the flags before starting the backend; the original UI process must emit these records to establish its latency.

The requested conversation was d6a68d4f-47cb-4f4a-9009-100e63e2b202, port 3000. PID 14920 initially listened there but was unavailable on the subsequent HTTP check. Comparison therefore used a newly launched instrumented backend on 127.0.0.1:3000 against the same persisted conversation, not the original UI process. No additional optimization was made.

The first existing-conversation request loaded two messages (432 characters / 448 UTF-8 bytes), no repeated messages and no pending expense/budget. It completed successfully with one insights execution and one OpenAI round. A second comparison, PID 17428, captured complete timings after the first request had appended its normal user/assistant turn:

| Stage | Existing conversation | Fresh conversation |
|---|---:|---:|
| Loaded messages | 4 | 0 |
| History bytes | 881 | 0 |
| History load / conversation creation | 5.36 ms | 3.52 ms |
| Financial insights tool | 31.18 ms | 7.96 ms |
| Final OpenAI response | 2937.75 ms | 2332.46 ms |
| Backend total | 3008.92 ms | 2362.55 ms |
| HTTP total | 3030.99 ms | 2365.73 ms |
| OpenAI rounds / insights executions | 1 / 1 | 1 / 1 |
| Input tokens | 3458 | 3230 |

The first differing stage is history loading versus fresh conversation creation, a difference of only 1.84 ms. The largest measured difference is final OpenAI generation (~605 ms); one sequential sample does not establish that history causes this difference. No minute-long hang, repeated tool loop, unresolved pending state or slow query was reproduced. Persisted history contains USER/ASSISTANT messages, not old tool-call results. The existing maximum remains four OpenAI rounds. The diagnostic requests append normal conversation turns; they do not alter financial records. Full second-run timing records are retained in ignored backend/.tmp/context-timings.json.
