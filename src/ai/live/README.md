# GPT-Live experimental — Phase 4 (confirmed expense writes)

Live client delegation connects to the existing finance agent for financial reads
and confirmed expense writes. No RealtimeTurnFilterService or old finance_turn
path is used. Confirmed balance-setting writes reuse PendingBankBalance;
budget writes remain unavailable through Live.
Chat, Realtime and legacy voice remain available. No dependency installation.

## Enable

Backend `.env`, then restart backend:

```dotenv
GPT_LIVE_ENABLED=true
OPENAI_LIVE_MODEL=gpt-live-1
OPENAI_LIVE_VOICE=vesper
LIVE_IDLE_TIMEOUT_MS=60000
LIVE_MAX_SESSION_MS=600000
```

Frontend `.env`, then restart Vite:

```dotenv
VITE_GPT_LIVE_ENABLED=true
```

Apply `npm run prisma:deploy` in backend before starting the new build. Migration
20261023000000_expense_payment_method has been applied to the local development DB.

Both flags default false. GPT-Live is never selected by default. Keep the existing
OPENAI_API_KEY on the server, with GPT-Live project access. Never use a VITE key.

## Connection and microphone ownership

After local wake detection, the shared runtime awaits detector suspension and
microphone/AudioContext release. The dedicated client checks GET /ai/live/config,
acquires its microphone, creates native WebRTC and the oai-events data channel,
gathers ICE and sends SDP to POST /ai/live/sessions. The backend calls SDK
client.live.create using gpt-live-1, store=false and delegation.type=client.
No managed Responses delegation or copied finance tools are configured in Live.
Client delegation is handled on the trusted backend sideband. The browser cannot
send financial state, user-turn replacements, tool arguments or delegation results.

The backend attaches SidebandWS from openai/resources/live/sideband/ws to monitor
lifecycle and receive delegations/transcripts. It returns only application
sessionId, local capability token, persisted conversationId and the SDP answer.
An existing conversation is validated or one is created through ConversationService.
X-Live-Token protects session status,
connected acknowledgement and stop. Browser data-channel commands are disabled
in the provider configuration; microphone audio travels only on WebRTC tracks.

The client waits for BOTH connected WebRTC and official session.started before
enabling microphone tracks and becoming ACTIVE. Multiple utterances use one
session. GPT-Live handles interruption natively: the client never sends Realtime
response.cancel or output_audio_buffer.clear commands.

Stop releases tracks, peer, data channel and audio srcObject. It awaits late
permission/SDP work before returning ownership to the armed wake detector; a
late-created remote session is cleaned up too. Remote cleanup HTTP is bounded
and does not block local wake resumption. Backend close sends session.close,
waits up to 1.5 seconds for finalization, releases sideband and performs bounded
SDK hangup. No automatic reconnect, replay or fallback to another voice mode.

## Idle, context and diagnostics

Idle defaults to 60 seconds; the hard maximum is 10 minutes and the connection
handshake deadline is 30 seconds. Distinct, nonempty official input/output
transcript deltas renew idle. Reflected audio, microphone samples, whitespace,
duplicates and polling do not. This simple Phase 2 proxy is NOT semantic
incidental-speech detection: background speech transcribed as text can still
renew idle. There is no additional classifier. Validate with a physical mic.

Idle/provider closure is normal: local resources close, runtime returns to IDLE
and an armed wake detector resumes. The same persisted conversationId is reused
across delegations and reconnect. Recent finance turns are loaded through the
existing ConversationService; verified tool-result JSON is saved in the existing
USER/ASSISTANT history format. The history service and its schema are unchanged.
Private balance interactions use the existing redacted history placeholder.
Restoring ordinary non-financial Live transcripts after reconnect remains outside
this phase. Expense pending state belongs to the persisted conversation, not the
Live session. Disconnect/reconnect never cancels the draft or invalidates its ID.

NODE_ENV=development enables backend live.* logs. Browser development builds show
session duration, runtime/connection and microphone state. No raw audio, transcript
contents, API keys or financial payloads are logged. User-speech start/stop,
response start/completion and barge-in logs are explicitly tagged estimates from
transcript activity/gaps, not invented API events, VAD or proof of audio playback.
Speaking/listening UI uses a 1.5-second transcript-gap estimate. Audio itself is
native Live media. API failures expose sanitized status/code/message in development
only, without silently switching to Realtime.

## Financial delegation and correlation

`session.delegation.created` contains delegation.id, target and offset_ms, NOT
user text. The coordinator accumulates server-observed input transcript deltas,
including whitespace fragments. It waits for 1500 ms of quiet fragment delivery
before freezing an application turn. It correlates the delegation offset with
that turn's audio timestamps (within 1500 ms after its end). Delegation may arrive
before transcript; it waits up to 6 seconds, then returns TURN_UNAVAILABLE rather
than guessing. Transcript-only events never execute finance work.

The SDK has no transcript-done/turn-complete event. This quiet boundary is an
application estimate, not proof of semantic completion. Very long pauses, unusual
delivery delays or delegations far beyond the utterance can require a repeated
question. No financial work starts directly from an individual fragment.

New input still suppresses older replies and obsolete reads/final saves. It does
not discard a pending-only CREATE/PATCH/CANCEL just because a continuation exists.
The singleton LiveFinanceAdapter owns a FIFO scoped by conversationId (including
overlapping Live sessions), with at most 8 admitted turns including the running
turn. Different conversations run independently; no global lock is used.

Intent is unknown before the existing semantic model response. Candidate turns
therefore wait in order without a second classifier/LLM call. At dequeue, the
agent loads fresh history and pending revisions. Once the tool identifies a read
or final save, supersession is checked before execution. Pending-only updates may
finish, but obsolete results are never sent to Live. A final save is still aborted
on newer speech, with the existing transactional signal/revision guards. There is
no permission for an obsolete CONFIRM to write an Expense or balance.

Consent spoken while prior work is processing, or while another turn occupies
the conversation queue, cannot save a newly prepared revision: the latest state
must be reviewed and a new, separate consent supplied. Expense STATUS is read-only
and returns the persisted PENDING/CONFIRMED/CANCELLED state; preparation is never
reported as a saved expense. No phrase lists select statuses, patches or consent.

Duplicate events/IDs and equivalent delegations for the same turn cannot execute
twice. Teardown aborts active work and removes waiting entries for that session;
persisted drafts survive. Failures release the queue without corrupting later
turns. A timed-out running job keeps its lane until its actual promise settles,
so it cannot overlap a later pending mutation. Queue overflow/timeout requires a
new user request, without automatic replay. The queue is in-memory per backend
process; existing database revision/transaction protections remain unchanged.

Development diagnostics live.write_queued (candidate awaiting semantic intent),
live.write_processing and live.write_patch_applied contain conversationId,
delegationId, queueDepth and pendingRevision (null before a snapshot is loaded),
never amounts, transcripts or balances.

There is a 35-second delegation budget including queue wait,
3 bounded argument-correction rounds (4 calls each),
and a 100-delegation session limit. Idle is suspended during delegated work; the
hard session cap remains. There are no automatic retries of failed user requests.

LiveFinanceAdapter calls `AiService.liveTurn`, not `chat`. The shared runner reuses
existing financeTools, executeTool, DTOs, analytics and privacy/date helpers.
AiService.readOnly still exposes only reads. Live explicitly supplies the shared
PendingExpenseService and the expense_intent control tool. No financial tools or
persistence logic are copied into the Live transport. Unknown tools remain blocked.

Result contract:

```json
{
  "type": "FINANCIAL_READ_RESULT",
  "conversationId": "persisted UUID",
  "data": [{ "tool": "get_monthly_summary", "result": {
    "period": { "year": 2026, "month": 10 },
    "totals": { "EUR": "156.83", "BRL": "97.00" }
  }}],
  "balanceDisclosureAllowed": false
}
```

Read control statuses include CLARIFICATION_REQUIRED and FINANCIAL_READ_UNAVAILABLE.
Write statuses are MISSING_INFORMATION, CONFIRMATION_REQUIRED,
DUPLICATE_CONFIRMATION_REQUIRED, EXPENSE_SAVED, EXPENSE_CANCELLED,
WRITE_REJECTED and WRITE_ERROR. No facts are extracted from model prose. Decimal and
Date serialization uses their existing JSON boundaries, never Number arithmetic.
Comparisons retrieve both existing monthly summaries; no new difference/percentage
calculation is added to the agent. Live must speak only returned backend figures.

Results use official `session.commentary.append` with the original delegation_id.
Larger JSON uses indexed, lossless `session.thinking.append` fragments followed by
a correlated complete marker via commentary. Each append is capped below 500 UTF-8
bytes, conservatively within the official 500-token limit. Results over 12 KB
return RESULT_TOO_LARGE and request a narrower query. Partial data is never
announced as complete. Merchant/descriptive strings remain untrusted data.

`balanceReadRequested` evaluates ONLY the complete current user turn, controls
tool exposure AND dispatch authorization. Old balance history is excluded and
private result values are not persisted into normal conversation history. The
current authorization flag accompanies every result; Live is instructed never to
reuse a prior balance result for another turn. Unsupported balance wording is
denied safely by the existing backend helper, without a new phrase classifier.

Development-only logs: live.delegation_created, live.delegation_correlated,
live.finance_start, live.finance_end, live.result_sent, live.delegation_error.
These carry session/conversation/delegation IDs, duration and status, not transcripts
or financial payloads. Delegation failure returns a safe correlated status and
keeps the session alive. Late results are discarded, not reused for a newer turn.

## Schema, draft state and confirmation

PaymentMethod is nullable on Expense and PendingExpense, using CARD, BANK_ACCOUNT,
CASH, OTHER. Existing rows remain null: no backfill or historical money changes.
Expense amount remains Decimal(19,2). Pending amount/currency/transactionDate alone
are now nullable so ANY subset of details can persist safely. These fields remain
required on final Expense; no placeholder amount/date/currency is invented.
The existing AccountOwner enum is unchanged; no new ownership field is added.

ExpenseIntentDto carries action (CREATE, PATCH, CONFIRM, DUPLICATE_CONFIRM, CANCEL,
NO_ACTION, STATUS) and explicit field/value changes. Amounts are decimal strings, dates
concrete ISO UTC dates. The finance model interprets the full current utterance,
including words/relative dates, against UTC today and a freshly loaded draft
snapshot. There are no new phrase lists, intent regexes or incidental classifier.
The Live model itself cannot supply financial state or authorize saving.

PendingExpenseService applies intents through its shared prepareDraft, patchDraft,
requestConfirmation, confirm and cancel operations. Existing chat uses the same
domain operations; its response contract and established routing remain. Merchant
mappings have precedence when classifying new drafts; semantic category works even
without merchant. Patches only change supplied fields, preserving omitted category,
payer, payment method, amount, date and optional text. A merchant correction alone
does not erase/reclassify an existing category. Merchant names are trimmed free text.

Derived backend states:

| State | Condition |
| --- | --- |
| AWAITING_DETAILS | amount, currency, date or payer missing |
| AWAITING_REVIEW | complete, confirmation not armed |
| AWAITING_CONFIRMATION | complete and reviewed current revision |
| SAVED | pending CONFIRMED with linked Expense |
| CANCELLED | pending CANCELLED |

Merchant and paymentMethod are optional. Unknown payer is never silently SELF.
After a clear payer correction, backend immediately patches it and requests only
the separate SAVE consent, without asking to reconfirm its meaning. Each edit
increments revision and invalidates prior save/duplicate consent. A confirmation
cannot contain changes: patch/review first, then a later explicit save turn.
Missing/unreviewed/stale/cancelled state cannot save. Ambiguous acknowledgement
must resolve to NO_ACTION/clarification, not CONFIRM. Domain guards independently
check the persisted revision/readiness/confirmation flag under the conversation lock.

Probable duplicates require a separate DUPLICATE_CONFIRM for the active duplicate
review. A repeated confirmed revision returns its linked Expense without creating
or debiting again. Another new expense in the same conversation advances revision.
The transaction covers permitted account debit, Expense insertion, category learning
and marking PendingExpense confirmed. Failure rolls back all of them. Abort is
checked before/after the locked operation; an already committed action cannot be
undone by interrupting voice, so lost replies must be resolved from persisted state,
never by replaying writes automatically.

| Payer/method | Personal bank impact |
| --- | --- |
| SELF + CARD/BANK_ACCOUNT | debit exactly one existing SELF account in the same currency |
| SELF + CASH/OTHER/null | no bank debit or implicit account creation |
| SPOUSE + any method | no personal bank debit |

All expenses still count in spending analytics. No account is guessed, no conversion
is added. Saving acknowledges expense success without returning/volunteering balance.

## Phase 4 manual acceptance

For rapid continuation acceptance, say exactly "Gastei 14 euros e 90 centavos no
PetStop." and, while its delegation is still processing, "No meu cartão." Verify
one PendingExpense with amount 14.90 EUR, PetStop, SELF/CARD and the newest
revision; no Expense/debit yet. If date or other required details are genuinely
missing, supply them rather than guessing. Ask "Registrou?": the returned state
must distinguish pending from saved. Confirm only after review; verify one save
and at most one eligible debit. Repeat confirmation: no extra save/debit. Also
say "Gastei 50 euros no Tesco." followed immediately by "Não, foram 15.": latest
pending amount must be 15, and a confirmation using the old revision must fail.

### Bank-balance writes

Live also delegates the BANK_BALANCE domain through `bank_balance_intent`, separate
from `expense_intent`. It reuses `BankAccountsService.prepare/arm/confirm/cancel`
and the existing PendingBankBalance revision, status and confirmation fields.
No new tables or migrations are required. Budget writes remain disabled.

CREATE and PATCH only prepare/review a draft. PATCH merges only explicitly
supplied currentBalance/currency/name with the persisted pending draft. Amount
and currency are required by the existing domain validation; incomplete input
asks for missing details without guessing currency or creating an account.
An amount-only setting request must supply the missing details before a complete
draft can be persisted. Signed exact decimal strings and EUR/BRL validation are
unchanged. The target remains the existing single SELF account per currency.

Only a later explicit CONFIRM calls the existing atomic/idempotent confirmation.
Edits with confirmation are reviewed and need another separate consent. Stale
revisions, cancelled drafts, mixed tool actions and malformed inputs cannot save.
Unrelated reads disarm balance confirmation; the next confirmation reviews again.
An aborted transaction rolls back; lost replies never trigger automatic replay.

BANK_BALANCE_CONFIRMATION_REQUIRED returns only the user-supplied pending draft
with balanceDraftDisclosureAllowed=true. This permits review, not disclosure of
the stored account balance. BANK_BALANCE_SAVED/CANCELLED contain no amount;
balanceDisclosureAllowed remains false. Balance write interactions are redacted
from stored conversational text, and completed draft snapshots omit their values.
Only a current explicit balance read may retrieve/disclose an account balance.

Manual acceptance: restart the backend and create a NEW Live session; activate
with VAS and wait for ACTIVE. Say "Meu saldo bancário é de 2000 euros." Verify
PendingBankBalance=PENDING, no BankAccount mutation and no Expense. Say "Na
verdade são 2100." Verify only amount changes and revision increments. Say "Sim."
Verify one SELF/EUR balance update and a brief acknowledgement without a value.
Repeat consent: no second mutation. Prepare a BRL update and cancel it: no BRL
account change. Ask "Qual é meu saldo?" explicitly to verify the saved amount;
then ask a spending question and verify the balance is not volunteered.

1. Apply the migration, restart backend/frontend and start a NEW Live session.
2. Enable wake and say VAS. While ACTIVE, no further wake word is needed.
3. Say “Ontem gastei cinquenta euros de combustível no meu cartão.” Expect a
   pending FUEL expense, SELF/CARD, yesterday UTC, no payer/card/merchant question.
   Confirm no Expense exists yet.
4. Say “Na verdade foram cinquenta e cinco.” Then “Foi no Circle K.” Verify
   only supplied fields changed and a fresh save confirmation is requested.
5. Say “Pode salvar.” Verify ONE Expense with amount 55.00, method CARD and the
   matching EUR account debited once. Repeating consent must not debit/save again.
6. Say “Gastei trinta euros no mercado e paguei em dinheiro.” Expect GROCERIES,
   SELF/CASH with no card question. Confirm and verify no bank debit.
7. Say “Minha esposa gastou vinte euros no Tesco.” Confirm payer SPOUSE and no
   personal bank debit; test cancellation before save as well.
8. Prepare another matching expense, confirm once, hear the duplicate warning,
   then explicitly authorize an intentional copy. Verify only one extra Expense/debit.
9. Leave a draft pending, Stop, reactivate with VAS and the SAME conversationId,
   then say “Pode salvar.” Verify persisted draft fields/revision are used.
10. While awaiting confirmation, speak about another topic or give an ambiguous
    acknowledgement. Verify no save. Corrections plus consent must review changes
    and require a later separate confirmation.
11. Repeat financial reads/follow-ups from Phase 3 and check EUR/BRL separation.
    No balance is volunteered after writing; only an explicit current balance query
    may disclose it. Confirm normal Stop/idle cleanup still resumes local wake.

## Read regression acceptance

1. Enable both flags, restart backend/Vite and select GPT-Live experimental.
2. Enable wake word and allow microphone access. Confirm wake listening, IDLE,
   GPT-Live disconnected.
3. Say VAS, pause and wait for ACTIVE_LISTENING. Wake must be suspended.
4. Ask “Quanto eu gastei este mês?”. Compare the EUR/BRL results with
   GET /analytics/monthly-summary?year=2026&month=10 (adjust the UTC month).
5. Without VAS, ask “E com pets?”. Verify the same conversationId in delegation
   logs and compare with GET /analytics/by-category using the same period/category.
6. Ask “Quanto eu gastei no Tesco?” and “Quanto eu gastei ontem?”. Compare with
   GET /expenses using the matching merchant/date filters. Do not add currencies.
7. Ask “Compare outubro com setembro.” Verify both monthly summaries. Arbitrary
   percentage/difference calculations not supplied by tools are not supported.
8. Ask an ordinary non-financial question. The live conversation should still work.
9. Exercise the confirmed-expense acceptance above. No write may be claimed complete
   before EXPENSE_SAVED; preparing/correcting alone must not create an Expense.
10. Ask another financial read. Check live.result_sent with a new delegationId and
    the same conversationId. There must be no browser /ai/chat or finance_turn call.
11. Ask “Qual é meu saldo?”, then an unrelated spending question. Only the explicit
    balance turn may disclose it. Also test interrupting a slow balance query with
    a new spending question: the older result must not be sent to the new turn.
12. Stop manually. Confirm disconnected, IDLE, old Live tracks ended and wake
    listening again. Repeat the idle/reconnect acceptance from Phase 2.

Automated tests mock OpenAI/WebRTC and run real shared domain services for writes,
including incomplete drafts, patches, cash/card/spouse/null-method policy, revision,
duplicates, rollback, reconnect and privacy, plus chat/Realtime/legacy regressions.
A PostgreSQL rollback-only verification also exercises persisted partial drafts,
idempotent confirmation, card debit and cash non-debit without retaining test rows.
Phases 2/3 were manually validated. Phase 4 semantic speech behavior still requires
browser acceptance. Do not proceed to cleanup or default-mode changes yet.

Official references: [WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc),
[sessions](https://developers.openai.com/api/docs/guides/live-conversations),
[delegation](https://developers.openai.com/api/docs/guides/live-delegation),
[prompting](https://developers.openai.com/api/docs/guides/live-prompting).
