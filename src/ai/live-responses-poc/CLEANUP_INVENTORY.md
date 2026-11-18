# Deferred cleanup inventory — no cleanup performed

All paths below are repository-relative. REMOVE means eligible **only after all
consumers of that responsibility have migrated and acceptance has passed**. A
read-only Phase 0 success does NOT authorize removing the current expense/balance
write path. This inventory is conditional; real-provider voice validation remains
pending. There are no deletion/refactor changes in this POC.

## Runtime candidates

| File | Function/class/field | Current responsibility | Disposition after migration | Dependency / removal risk |
|---|---|---|---|---|
| backend/src/ai/live/live-delegation.ts | LIVE_TURN_SETTLE_MS; LiveDelegation.accept(), quiet timer | Finalize locally after 1500 ms of transcript silence | REMOVE | Only once managed structured calls replace ALL client finance requests, including writes. Must not replace with another timing heuristic. |
| backend/src/ai/live/live-delegation.ts | LiveDelegation.drain(); Pending.offset/deadline | Match transcript audio range to delegation offset; wait up to 6 s | REMOVE | Managed delegation/response/call IDs must be validated instead. Late/missing IDs need explicit protocol handling. |
| backend/src/ai/live/live-delegation.ts | Turn.used / DUPLICATE_TURN | Limit each reconstructed turn to one delegation | REMOVE | Keep exact event/call ID deduplication. Different managed calls may legitimately belong to one conversational request. |
| backend/src/ai/live/live-delegation.ts | revision, Turn.revision, isCurrent callback | Increment on fragments and gate execution/results | REMOVE | Do not remove domain draft revisions. Managed operations need their own explicit identity and reviewed-revision checks. |
| backend/src/ai/live/live-delegation.ts | accept() aborting READ/COMMIT jobs; execute() SUPERSEDED handling | Cancel/discard work based on newer local fragments | SIMPLIFY | Replace only fragment-based cancellation. Backend jobs still require explicit cancellation/obsolete-task handling; Live barge-in does not undo work. |
| backend/src/ai/live/live-delegation.ts | execute(); 35000 ms timer / Promise.race | Bound financial delegation including queue wait | SIMPLIFY | Keep bounded backend operations and late-result rejection. Do not confuse timeout with cancellation or spoken completion. |
| backend/src/ai/live/live-delegation.ts | jobs size gate, 100-delegation limit, event/seen sets | Session capacity and deduplication | SIMPLIFY | Port bounded capacity and structural-ID deduplication to the managed handler before retiring this coordinator. |
| backend/src/ai/live/live-delegation.ts | resultEvents() | Fragment JSON into thinking/commentary appends | REMOVE | Managed function outputs return by call_id through response.item.create. Keep result size bounds; other client-mode consumers must be gone. |
| backend/src/ai/live/live-delegation.ts | failure(), close() | Safe fallback, abort jobs and timers | SIMPLIFY | Preserve error/no-facts distinction and teardown in the replacement; do not delete resource cleanup. |
| backend/src/ai/live/live-turn-queue.ts | LiveTurnQueue.enqueue()/pump(); lane.latest | Serialize all Live interpretation/read/write candidates and identify newest ticket | REMOVE for migrated reads; SIMPLIFY for future writes | Reads need no mutation FIFO. Writes may still need ordering per draft/conversation. Never remove DB locks, revision/idempotency protection or serialize unrelated conversations globally. |
| backend/src/ai/live/live-turn-control.ts | LiveTurnControl / LiveOperation | Couple interpretation phase and fragment currency to execution | REMOVE | Only after the client runner stops using it. Managed tool execution needs explicit validation and operation guards instead. |
| backend/src/ai/live/live-finance.adapter.ts | execute(); waited / confirmationAllowed | Queue a reconstructed request and gate confirmation by occupancy | REMOVE | Only after managed WRITE migration. Consent must bind to the correct reviewed draft revision, not queue emptiness. Phase 0 cannot establish that guarantee. |
| backend/src/ai/live/live-finance.adapter.ts | openConversation() | Validate/create persisted application conversation | SIMPLIFY | Keep application conversation lifetime and pending-state restoration for writes. The POC's intentionally fresh sessions are not a full replacement. |
| backend/src/ai/ai.service.ts | liveTurn() | Start separate app-owned LLM interpretation through runFinancialRead | REMOVE | Remove only this Live entry after migration; chat(), readOnly(), executeTool() and other transports are separate consumers and must stay. |
| backend/src/ai/financial-read.ts | runFinancialRead(); deps.control/writes/balanceWrites; operation() | Independently interpret text, select tools and protect Live writes | SIMPLIFY | Retire Live-only orchestration after all consumers migrate. Keep any remaining readOnly caller, DTOs, existing dispatcher and financial safety; do not delete the whole file blindly. |
| backend/src/ai/financial-read.ts | history construction / authoritative snapshots | Rebuild app-owned Live finance model context from saved turns and pending state | SIMPLIFY | Managed Responses owns conversational model context; backend remains source of truth for drafts. Preserve private balance redaction and current-turn authorization rules. |
| backend/src/ai/live/live.service.ts | event(); userSpeaking/userEnd (1000 ms) | Estimate user speech start/end and barge-in from transcript arrival | SIMPLIFY | UI/diagnostics only. These currently do not themselves authorize a financial mutation; remove only duplicated estimates, not semantic write guards. |
| backend/src/ai/live/live.service.ts | event(); speechEnd (1500 ms), response_started/completed | Estimate assistant speaking/listening from output transcript gaps | SIMPLIFY | Never replace with response.completed as an audio completion signal. Preserve honest UI estimates or actual player activity; do not derive confirmation authority from them. |
| backend/src/ai/live/live.service.ts | work() callback / renewIdle() | Tie idle session handling to client delegation jobs and transcript activity | SIMPLIFY | Drive backend-job activity from managed handler lifecycle; preserve idle/max cap and application conversationId across disconnect. |
| backend/src/ai/live/live.service.ts | create()/connected()/close()/onModuleDestroy() | Session auth, connection handshake, caps and cleanup | KEEP / adapt wiring | Needed regardless of delegation owner. Remove only dependency on the old coordinator when fully migrated. |
| backend/src/ai/live/live.transport.ts | offer() | Build client-delegation SDK session payload | SIMPLIFY | Change only when migrating deliberately; managed config/tools replace client delegation. Preserve server-only key/voice and browser event restrictions. |
| backend/src/ai/live/live.transport.ts | attach()/hangup(); 10 s connection, graceful close timers | Sideband transport and resource cleanup | KEEP | Mode-independent; reused unmodified by the POC. These are connection timers, not obsolete turn watchdogs. |
| backend/src/ai/live/live.prompt.ts | LIVE_INSTRUCTIONS client result/RESULT_PART policy | Explain client-mode delegation and write-result speech | SIMPLIFY | Replace client-result mechanics only after migration. Preserve language, factuality, currency separation, privacy and explicit confirmation requirements. |
| backend/src/ai/live/live.module.ts | LiveModule providers | Register old transport/service/adapter | SIMPLIFY | Retire adapter/coordinator dependencies only after their routes/users migrate. Do not leave both paths active unintentionally. |
| frontend/src/live-client.ts | event(); speaking/speakingEnd; estimated barge_in | Duplicate speech UI estimates | SIMPLIFY | These are display estimates, not backend authorization. Transcript caption data may remain. Live still owns conversational interruption. |
| frontend/src/live-client.ts | start()/ready()/stop(); connection deadline/ICE/polling | WebRTC setup and lifecycle | KEEP / adapt route | Needed independently of managed delegation. Preserve native audio tracks, ready gating, cleanup and recoverable disconnect. |
| frontend/src/LiveVoice.tsx | LiveVoice displayRuntime, current client construction | Render state and wire wake/runtime to current transport | SIMPLIFY | Only change endpoint/client wiring after migration; retain manual fallback, conversationId and microphone ownership. |
| frontend/src/voice/voice-runtime.ts | createVoiceRuntime(); generation/start/stop/dispose | IDLE/ACTIVATING/ACTIVE and wake microphone handoff | KEEP | Connection generation is not a financial fragment revision. Removing it risks duplicate sessions, late permission leaks and wake regressions. |
| backend/src/pending-expenses/pending-expense.service.ts | applyIntent(), prepareDraft(), patchDraft(), requestConfirmation(), confirm(), locked() | Domain validation, draft revision, explicit confirmation, duplicate review, atomic/idempotent save | KEEP | Managed delegation must call the same domain. Read-only POC success proves no safe write migration. |
| backend/src/bank-accounts/bank-accounts.service.ts | prepare()/arm()/confirm()/cancel()/locked() | Personal balance drafts and exactly-once persistence | KEEP | Bank access is intentionally excluded from Phase 0; current-turn privacy and reviewed-revision consent are migration blockers. |
| backend/src/ai/balance-privacy.ts | current-turn authorization/redaction helpers | Prevent unauthorized balance disclosure | KEEP | No model-generated tool call alone proves authorization. Must be validated separately before balance migration. |
| backend/src/conversations/conversation.service.ts | recentMessages()/saveTurn() | Persist application context | KEEP / adapt consumers | Provider session context does not replace the app conversation, financial audit/status or reconnect requirements. |

## Tests coupled to the old architecture

| File / test | Later action | What must survive |
|---|---|---|
| backend/src/ai/live/live-delegation.spec.ts: waits for all fragments; preserves spaces; delegation-before-transcript; no correlated complete transcript; stale offsets | REMOVE or replace with managed event-order/association fixtures | No guessing of commands; known delegation/response/call_id association. |
| same file: deduplicates equivalent delegations for one turn | REWRITE | Keep exact call/event deduplication; remove one-delegation-per-local-turn assumption. |
| same file: late result after newer input | REWRITE | Explicit obsolete task/privacy protection, without fragment-wide aborts. |
| same file: resultEvents byte-safe thinking/commentary parts | REWRITE | Function outputs returned once per call_id; bounded result size and exact Decimal strings. |
| same file: cleanup, safe failure, unresponsive reads | REWRITE harness | Keep cleanup, no replay, bounded work, unavailable-not-zero and stale-result suppression. |
| backend/src/ai/live/live-turn-queue.spec.ts | REMOVE for read-only managed entry; reassess for writes | Retain bounded mutation ordering, cancellation and failure isolation if a write queue remains necessary. |
| backend/src/ai/live/live-write-continuation.spec.ts | REWRITE coordinator/event harness after WRITE migration | Keep PetStop+card continuation, rapid corrections, old revision rejection, no premature save/debit, exactly once, rollback, status distinctions and teardown. |
| same file: cannot save consent while processing | REWRITE predicate | Test explicit reviewed revision/consent rather than jobs.size or queue occupancy. Do not delete the safety requirement. |
| backend/src/ai/live/live-finance.adapter.spec.ts: uses restricted entry, never chat | REWRITE / retire adapter-specific assertion | Ensure managed path never calls chat()/standalone responses.create or legacy coordinator. |
| backend/src/ai/live/live.transport.spec.ts: client delegation/no tools payload assertions | REWRITE after payload migration | Keep SDK shape, secret isolation, configured voice, data-channel restrictions and cleanup checks. |
| backend/test/live.e2e-spec.ts | KEEP now; later replace client transcript/offset fixtures | Preserve domain outcomes and Phase 3/4 acceptance, auth, normal close, privacy and money invariants. |
| backend/src/ai/live/live-expense.spec.ts; live-bank-balance.spec.ts | KEEP business cases; adapt tool-delivery seam only after write parity | Creation vs pending, payer/method policy, duplicates, revisions, explicit consent, atomic debit and balance privacy. |
| backend/src/ai/financial-read.spec.ts | KEEP remaining readOnly cases; adapt Live-only assertions | Read authorization, no prose financial facts, exclusions/default periods and EUR/BRL separation. |
| backend/src/pending-expenses/*.spec.ts; backend/src/bank-accounts/*.spec.ts; expense/analytics tests; chat/legacy/Realtime e2e | KEEP | Shared domain and other active transport guarantees. Not legacy merely because client delegation is retired. |
| frontend/test/live-client.test.mjs | KEEP lifecycle cases; adapt endpoint/payload expectations | WebRTC/microphone cleanup, ready gating, auth secrets, normal close and no mode crossover. |
| frontend/test/wake-word.test.mjs; teachable-machine-engine.test.mjs | KEEP | Wake detection, stream ownership, no IDLE network audio and resource cleanup. Not part of finance turn reconstruction. |

## Decision gates before any removal

1. Real managed Live speech and natural category/merchant follow-up acceptance.
2. Same domain results and Decimal/currency semantics, with explicit errors.
3. Write migration separately proves revision-bound consent and exactly-once debit.
4. Bank migration separately proves CURRENT-turn authorization and speech privacy.
5. Reconnect context restoration, active task ownership, cancellation and cleanup.
6. A controlled cutover/rollback plan and no remaining consumers of removed code.

The POC does not satisfy gates 3–5 and makes no cleanup changes.
