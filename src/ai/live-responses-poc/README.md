# Phase 0: isolated managed Responses delegation

This experiment does not replace the client-delegation mode. Its routes, session
map, protocol handler and browser entry are separate. No schema/migration change,
conversation persistence, pending state, balance access or write capability exists
in the POC. Production always refuses session creation, even if the flag is true.

## Enable explicitly

From `backend/`, use a development process with the existing OpenAI/PostgreSQL
configuration. The installed SDK is OpenAI 7.30.0. No dependency changes:

```powershell
$env:NODE_ENV = 'development'
$env:GPT_LIVE_RESPONSES_DELEGATION_EXPERIMENT = 'true'
npm run start:dev
```

The default in `.env.example` remains false. `GPT_LIVE_ENABLED` does not select the
POC. It continues to control the existing Live path independently. Model/voice
come from OPENAI_LIVE_MODEL/OPENAI_LIVE_VOICE; managed backend model comes from
OPENAI_CHAT_MODEL. No OpenAI key or voice env variable is added to the frontend.

Run the normal Vite dev server in `frontend/`, stop any other microphone session,
then explicitly open **http://localhost:5173/live-responses-poc.html** (adjust port).
This is a separate dev entry, not a new default or option in the production App.
Click Start, allow the microphone and wait for connected. Click Stop afterwards.
The page is not an entry of the normal production Vite build and has an additional
`import.meta.env.DEV` gate. All backend operations are guarded independently.

## Exact SDK contract

1. `PocTransport.create()` calls `client.live.create()` using the existing SDK's
   `LiveCreateParams`: `session.delegation = { type: 'responses', responses: {
   model, instructions, tools, parallel_tool_calls: false, tool_choice: 'auto' } }`;
   `transport = { type: 'webrtc', sdp }`. Browser audio still uses native tracks.
2. Sideband `session.delegation.created` with target=responses announces
   `delegation.id`, optionally its initial `response_id`. `offset_ms` is unused.
3. `response.event` has `delegation_id` and an inner event typed by the Live SDK
   as `Record<string, unknown>`. The backend checks that the delegation is known.
4. Inner `response.created` announces `response.id`. Responses can continue with
   a NEW response ID under the same delegation. Track association structurally.
5. Inner `response.output_item.done` contains `item` with `type=function_call`,
   `name`, JSON-string `arguments`, `call_id`, and item id/status. The installed
   `ResponseOutputItemDoneEvent` has **no response_id property**. It belongs to the
   announced response for this delegation, not a transcript or time window.
   Argument delta/done events alone are never executed.
6. The completed function's arguments are parsed and validated using the existing
   SpendingPaceToolDto, including strict unknown-field rejection, before analytics.
7. The result is returned with `response.item.create`, whose `item` is
   `{ type: 'function_call_output', call_id, output: JSON.stringify(result) }`.
   There is no separate success acknowledgment for this command.
8. Once the backend response is complete AND all its function results have been
   submitted, send `response.create` once. `response.completed` output arrays are
   intentionally empty in forwarded lifecycle snapshots; they are not used to
   recover tool calls. `response.created`/completed describe backend responses,
   not the end of the user's spoken turn or assistant playback.

The current LiveTransport is reused ONLY for mode-independent sideband attachment
and graceful hangup. Its current `offer()`/client-delegation builder is never
called or modified. The experiment has its own SDK-typed managed payload builder.
No `AiService`, `LiveFinanceAdapter`, `LiveDelegation`, transcript finalizer,
fragment revision or write queue participates in the experimental request path.
No standalone `client.responses.create()` is called by the app: the provider owns
the managed Responses orchestration. A backend model still exists and is billed;
this removes a separate app-owned interpretation call, not model reasoning itself.

Official sources: [managed delegation](https://developers.openai.com/api/docs/guides/live-delegation),
[SDK reference](https://developers.openai.com/api/reference/typescript/resources/live).

## Single capability and safety

`get_spending({ year, month, merchant, category, currency })` is the only allow-listed
tool. Optional filters are nullable; currency is EUR/BRL and category uses the
controlled enum. A category/merchant follow-up must arrive as a fresh structured
call; the POC never reconstructs the prior sentence to fill it in.

PocSpendingService delegates to existing AnalyticsService.spendingPace(). It returns
only that service's per-currency `spentToDate` totals and effective UTC period.
Current month means month-to-date, past months are full calendar months, future
months follow the existing service's zero behavior. Averages/projections are not
exposed. No amount arithmetic or Number conversion is added in the AI layer.
Database failures are errors, not zero totals. No Prisma access from this layer.

Unsupported tools (including bank balance reads and every write) return a tool
error and never reach domain execution. The POC does not import BankAccountsModule,
PendingExpensesModule, FinanceAgentModule or LiveModule. No application
conversationId is accepted/persisted. Live retains conversational context only
within this experimental session; reconnect starts fresh.

Calls are deduplicated by call_id. Limits are 3 active sessions, 32 delegations and
64 backend responses/calls per session. Connection setup has a 30-second budget;
the hard session cap is at most 10 minutes. These are lifecycle limits, not speech
finalizers. Closing suppresses late read results; no automatic financial retries.

Development logs: live.responses_delegation_created, responses_call_received,
responses_call_validated, responses_finance_start/end, responses_result_sent.
They contain local Live sessionId, delegationId, call_id/tool where applicable and
duration, not raw audio, arguments, transcript text, financial results or API keys.
Browser captions are bounded diagnostic UI text only.

## Validation and manual acceptance

Automated tests inject SDK-shaped delegation/response events and run backend
validation plus the existing analytics service. There are no input transcript
events or silence timers in the positive execution tests. They establish contract
handling and isolation, not real-model speech understanding or provider delivery.

Manual evidence still required before declaring the POC successful:

1. Open the separate page, Start, and wait for connected.
2. Say "Quanto eu gastei este mês?". Verify one structured get_spending call in
   development logs and compare returned totals with existing spending analytics
   for the effective UTC period. EUR/BRL must be spoken separately.
3. Without reconnecting, say "E com pets?". Verify a NEW call with category PETS
   and the same intended month, without any application-side sentence reconstruction.
4. Ask about Tesco in that month. Verify a merchant-filtered structured call and
   authoritative backend totals. Repeat with a historical month.
5. Ask to record an expense and ask for bank balance. Neither capability exists;
   verify there is no domain write or bank lookup and no invented financial answer.
6. Stop and verify microphone/WebRTC/sideband cleanup. The ordinary App and its
   existing Live mode must still work unchanged when the experiment flag is false.

Recommendation until that real-provider/browser evidence is collected:
**CONTINUE INVESTIGATION**. Managed SDK contracts and mocked execution alone do
not prove natural follow-up reliability, heard speech correctness, or future
current-turn bank authorization. No writes or cleanup are authorized by this POC.

The later-migration inventory is in [CLEANUP_INVENTORY.md](CLEANUP_INVENTORY.md).
