# VAS Voice Runtime — phase 1.5

This optional WebRTC path coexists with the legacy POST /ai/voice push-to-talk flow. No wake word, continuous background listening, schema migration or financial-domain rewrite is introduced.

## Architecture and deliberate tradeoff

Browser microphone -> OpenAI WebRTC session -> streaming input transcription -> semantic directionality filter -> (accepted only) server-side forced finance_turn call -> existing AiService.chat -> isolated Realtime streamed audio -> browser audio element. This bypasses upload/file transcription, legacy AudioService.speak and MP3/base64 response generation. Realtime input transcription is supplied by the session's gpt-4o-mini-transcribe auxiliary ASR, not a POST to the legacy transcription route.

The thin finance_turn adapter takes **no message arguments**. Only the server-observed utterance and server-owned conversationId are passed to AiService. All existing financial tools, Decimal arithmetic, category mappings, payer rules, budget guidance, recurrence, insights, duplicate checks, pending reviews, explicit confirmation, cancellation and idempotency stay there. This conservative phase deliberately retains the existing chat orchestrator (including its Responses model calls); Realtime does not independently implement or calculate finance. One extra forced Realtime function selection precedes the financial turn. Streaming improves audio delivery but does not remove domain/chat latency; measure rather than assume an improvement.

Persisted Conversation/ConversationMessage semantics remain those of AiService, including bank-interaction redaction. Same conversationId can be reused after stopping/restarting or switching modes. The browser keeps it only in the mounted app, as before.

## Incidental speech filter

RealtimeTurnFilterService runs before any routing response/finance_turn, serially
in the existing turn queue. Wake-word activation protects IDLE -> ACTIVE; the
classifier is secondary conversational filtering, not write/balance authorization.
A bounded Responses structured-output classifier assists the backend. It uses
OPENAI_REALTIME_FILTER_MODEL (default gpt-6-luna), tools=[],
tool_choice=none, store=false, 256 output tokens and no retries. A three-second
budget covers both context loading and inference, with cancellation on stop or
interruption. No financial agent or write capability is added.

Input signals: the captured utterance, up to six recent persisted messages
(600 characters each), active pending Expense/Budget/BankBalance kinds and their
confirmationRequested flags, assistant state at speech onset, accepted-turn
count, reconnect flag and arrival during a financial operation. Existing domain
services supply pending metadata; the AI layer never accesses Prisma. It reads
no bank account balances. Entire bank-related messages are omitted using the
existing privacy guard, including spelled-out values; only private intent kind
is supplied. Other numeric tokens are redacted. No amounts, account values or
merchant details from pending rows are included. History, metadata and transcript are
untrusted classification data, never executable instructions.

| Classification | Runtime behavior |
| --- | --- |
| DIRECTED_TO_ASSISTANT | Continue through finance_turn, subject to the pending-confirmation gate below |
| LIKELY_INCIDENTAL | Silently drop; no routing, tools, clarification, audio, normal history turn or UI error |
| UNCERTAIN | Same silent drop; never promote to directed based on financial vocabulary alone |
| FILTER_TIMEOUT / FILTER_UNAVAILABLE | No semantic classification (`classification: null`). While listening, the existing fallback remains available only when loaded context establishes that no confirmation is awaiting. Pending confirmation or unknown context fails closed and stays silent. Fallback does not renew inactivity. |
| FILTER_CANCELLED | Never fall back; stopped/interrupted/superseded turns cannot execute. |

Strong conversational/pending evidence must be resolved by the semantic model
as DIRECTED_TO_ASSISTANT. Pending state alone is not sufficient. Existing short
confirmation/cancellation semantics run only after acceptance; no new phrase
lists, speaker matching or punctuation rules classify direction. ask_clarification
remains exclusively inside AiService for an accepted turn. Filtering does not
change POST /ai/chat or legacy POST /ai/voice. Ignored utterances do not renew
idle lifetime; capture, queues and in-flight classification do not pause its
deadline. Accepted semantic turns and their completed assistant responses renew it.

When a pending Expense/Budget/BankBalance has confirmationRequested=true, the
same classifier also returns pendingAction: CONFIRM, CANCEL, EDIT_PENDING,
UNRELATED or UNCERTAIN. Otherwise pendingAction must be null. No additional model
round or language/phrase detector is added. Direction alone is insufficient:
UNRELATED and UNCERTAIN are silent even if classified as directed. CONFIRM/CANCEL
must also satisfy the existing backend explicit-action policy before routing;
classification never expands that authorization or synthesizes a user message.
Acknowledgements alone cannot save. EDIT_PENDING delegates the original transcript
to the existing semantic patch flow. Ignored turns produce no finance_turn,
history message, fallback text or audio and leave pending state untouched. Pending
metadata is loaded from domain services, never inferred from assistant prose.
Context-loading failure uses awaitingConfirmation=unknown and cannot enable a
permissive fallback. POST /ai/chat and its financial-evidence fallback are unchanged.

The response contains classification, a fixed reasonCode enum and nullable pendingAction, not rationale
or free-text reasoning. A valid semantic UNCERTAIN remains distinct from an
infrastructure failure. The unchanged 3000ms total budget produces FILTER_TIMEOUT;
invalid output, refusal, unexpected tool output, unavailable storage and API/model/
network errors produce FILTER_UNAVAILABLE. These do not authorize any financial
fact or write: AiService retains backend validation, pending-only preparation,
separate confirmation, SELF/SPOUSE handling and current-turn balance privacy.
No phrase list or financial sentence matching decides fallback. The first turn
of an active conversation is eligible; prior accepted turns are not required.
Manual Start establishes the same active session context as wake activation.
Development-only
realtime.turn_filter logs include classification, reasonCode, transcriptLength,
assistantState, pendingStateExists, fallbackAccepted, skippedFinanceTurn and durationMs, plus
session/conversation IDs. They contain no raw transcript, financial values or
balance. Safe `realtime.turn_filter_failure` warnings are emitted in production
as well as development, distinguishing FILTER_TIMEOUT from FILTER_UNAVAILABLE,
with fallback outcome and elapsed time; no raw transcript/provider error is logged.
RealtimeService.getTurnFilterMetrics() exposes a copy of process-local counters:
filterSuccess (all valid semantic results), filterTimeout, filterUnavailable,
fallbackAccepted and fallbackRejected. Counters reset on process restart;
development `realtime.filter_metric` records also expose increments. No metrics
HTTP endpoint or additional monitoring dependency is introduced. Accepted fallback
does not repeat classification or any financial operation.

Barge-in remains immediate. Provider VAD/browser playback clearing can interrupt
an answer before the transcript is classified, including for subsequently ignored
background speech; this phase does not replay interrupted audio. An accepted
interruption is processed normally. Already-started accepted financial operations
settle once, never replayed because of interruption/filter failure.

This is conversational filtering, not speaker recognition, authentication or a
wake word. Nearby speech that resembles a valid assistant command can be accepted;
genuine short utterances can be missed. Private balance wording is deliberately
withheld and may therefore be classified conservatively. The extra classifier
adds inference latency, bounded by three seconds, with possible false negatives
on timeout. Mocked tests establish safe dispatch and context construction, not
real-world semantic accuracy. Validate real voices, languages, background speech,
latency and barge-in before the separate wake-word milestone. No wake word is
implemented here.

### Conversation-mode requirement for the wake-word milestone

The wake word "VAS" is required only for IDLE -> ACTIVE. Once ACTIVE, direct
questions and contextual follow-ups are processed without repeating the wake
word or assistant name. The sequence "VAS" -> activation -> "Quanto gastei este
mês?" -> "E com pets?" -> "E no Tesco?" stays in one active conversation.
Only after returning to IDLE is another wake-word activation required.

The current phase starts ACTIVE through the existing manual Start action; it
does not detect "VAS" or provide an IDLE microphone listener. The directionality
classifier operates only inside that active session. Incidental speech filtering
still applies, and its UNCERTAIN result does not end the session or require a
new wake word. Idle/max timeout or Stop ends the current active session without
invalidating the persisted conversationId. Future activation must reuse that
conversation context where appropriate.

## Authorization and privacy

NestJS sends SDP + server-owned configuration to POST https://api.openai.com/v1/realtime/calls using the permanent API key. It attaches an SDK server WebSocket using the returned call ID **before** releasing the SDP answer to the browser. Browser receives answer SDP, local session UUID, conversationId and a random session capability token; it never receives the permanent key or an OpenAI ephemeral credential. Status/connected/stop require X-Realtime-Token. Session capabilities are memory-only, bounded and never logged. Existing application authentication/conversation ownership is unchanged: this remains the trusted personal/local app, not a new multi-user authorization system. An authenticated deployment must bind creation to its authenticated user before public exposure.

Automatic Realtime responses are disabled (VAD create_response=false). Routing is text-only, forced to finance_turn, with conversation=none and explicit current-turn input. Model tool arguments cannot fabricate confirmation or replace the utterance; unknown tools/arguments cannot reach financial services. Duplicate events cannot reexecute a turn. A yes queued while the previous review is still being computed is refused until a later confirmation; interruption does not undo or repeat a transaction already started.

Audio generation is separately forced to tools=[]/tool_choice=none, conversation=none, with only the current backend-approved speech text as input. No previous financial result or bank balance is added to the default Realtime conversation. Input audio items are deleted after their transcripts reach the server. Existing AiService current-turn balance guard, protected balance reads and history redaction remain authoritative. Only an explicitly requested current balance can be included in the authorized speech text. The existing money/date speech formatters are reused without changing visible API values. As with any generative audio model, manual transcript/listening validation is still required; streaming cannot retrospectively redact audio already played.

## Configuration and API

```env
VOICE_RUNTIME_MODE=legacy
OPENAI_REALTIME_MODEL=gpt-realtime-2.1-mini
OPENAI_REALTIME_VOICE=marin
OPENAI_REALTIME_FILTER_MODEL=gpt-6-luna
REALTIME_IDLE_TIMEOUT_MS=60000
REALTIME_MAX_SESSION_MS=600000
```

VOICE_RUNTIME_MODE selects the initial UI mode only; both choices remain available for comparison. Realtime model/voice are independent of OPENAI_CHAT_MODEL and legacy OPENAI_VOICE. Invalid values fail clearly. No model is silently substituted if upstream access fails. Backend .env contains OPENAI_API_KEY as before; never put it in VITE_* configuration.

| Endpoint                                 | Purpose                                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| GET /ai/realtime/config                  | Non-secret initial mode and realtime model                                                          |
| POST /ai/realtime/sessions               | JSON {sdp, conversationId?}; validates SDP/UUID, returns {sdp,sessionId,token,conversationId,model} |
| GET /ai/realtime/sessions/:id            | Capability-protected state and latest ten approved text turns; no audio payload                     |
| POST /ai/realtime/sessions/:id/connected | Capability-protected WebRTC connection acknowledgement                                              |
| POST /ai/realtime/sessions/:id/stop      | Capability-protected, idempotent disconnect/hangup                                                  |

Frontend polls approved text/state at 500 ms while audio streams directly over WebRTC. It shows disconnected/connecting/listening/processing/speaking/error, exposes audio controls for autoplay recovery and stops tracks/peer/data channel/polling on disconnect/unmount/error. A stop racing setup releases the returned remote session when possible. Sessions without a completed browser handshake expire after 30 seconds. Explicit restart is required after errors; no automatic financial replay or automatic legacy resubmission occurs. The legacy selector is disabled while a session/recording is active.

### Connection lifetime versus conversation lifetime

REALTIME_IDLE_TIMEOUT_MS defaults to 60000 (60 seconds). RealtimeService tracks lastAcceptedActivityAt and derives its absolute idle deadline from it. Session creation, accepted semantic user turns and their authorized assistant response/playback activity renew it. Raw speech, queued transcripts, classification, ignored/uncertain speech, polling and classifier failures do not. In particular, classification at T=40 taking two seconds still leaves the original T=60 deadline. Even continuous unaccepted speech or a hung filter cannot pause it. Only an already accepted operation or its authorized playback suspends idle processing until completion; response completion then starts a fresh interval. Playback events must match an authorized speech response. REALTIME_MAX_SESSION_MS remains 600000 (10 minutes), never renews, and closes even a busy session. The 30-second handshake and processing watchdog remain unchanged. Both environment settings must be positive integer milliseconds at most 2147483647; invalid configuration fails startup. A smaller maximum than idle is allowed and wins.

The timers live only in RealtimeService. Idle/max expiration closes the WebRTC/sideband call and eventually removes only its temporary in-memory runtime state. It never deletes or invalidates the persisted conversationId, conversation messages or pending financial state. Reconnect with the same conversationId to continue: session creation validates the stored conversation, then AiService loads the latest 20 persisted messages on each financial turn, with the existing bank-privacy redaction. No private historical balance is restored to the Realtime audio conversation. A contextual follow-up such as "E com pets?" therefore receives its earlier category/period context through the existing chat orchestrator. The 30-second browser handshake deadline and processing watchdog remain unchanged.

Development logs include turn_accepted, turn_ignored, pending_action and idle_deadline. The latter contains reason, acceptedActivity, remainingIdleMs and paused. Existing idle_timer_reset, idle_timeout_close, max_session_close and conversation_reused logs remain. session_created includes configured limits; connection_closed records conversationIdPreserved=true. Each includes sessionId/conversationId without message content, raw audio or financial values. Enable NODE_ENV=development to see them in the backend console.

The backend serializes turns by VAD stop order, bounds the queue to three, deduplicates up to 100 utterances/session, allows at most 20 concurrent/creating sessions and times out missing transcription or a stalled routing/audio-generation response after 30 seconds. Existing AiService keeps its own bounded tool loop/timeouts. On barge-in, VAD cancels playback and server state discards interrupted audio work; any already-started domain operation settles once and its approved text remains available. Completed audio generation releases the processing state even if playback events are missing. Browser speaking state follows playback events separately.

## Diagnostics, tests and manual acceptance

Development JSON logs: realtime.session_created, connection_established (sideband vs WebRTC), tool_start/tool_end, first_audio, turn_end, error and connection_closed. They include IDs, tool name and durations, never API keys, capability tokens, balances, transcripts or audio payloads. Browser [REALTIME] logs include connection duration, VAD-stop-to-first-audio and playback completion/interruption duration. Backend turn_end is generation/processing completion, not necessarily audible playback completion. Sideband first_audio is provider event timing; browser first_audio is the closer perceived-latency measure. Never compare mock-clock latency to a live connection.

Backend tests mock transport and OpenAI but run actual controller, adapter, AiService and expense/balance confirmation logic. They cover key isolation, capability checks, category/budget/recurring/insight delegation, SELF/SPOUSE, no save before confirmation, duplicate events, queued premature yes, balance isolation and disconnect/error. Legacy suites remain. Frontend native Node tests mock browser/network APIs to exercise cleanup, setup failure, state transitions and existing conversation propagation without adding dependencies. Microphone, real WebRTC and generated audio correctness require manual acceptance.

Manual acceptance, same session: groceries -> monthly insights -> required budget reduction -> "Gastei 20 euros no Tesco no meu cartão." -> wait for review -> "Pode salvar." -> "Qual meu saldo?" -> unrelated expense question. Confirm the expense/debit occurs exactly once; the final unrelated speech must not disclose the balance. Also interrupt audio, stop/restart, deny microphone permission and verify legacy fallback. Use a test database for synthetic write fixtures.

Official references: [model](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini), [unified WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc), [server sideband](https://developers.openai.com/api/docs/guides/voice-server-controls?api=realtime&voice-api=realtime), [isolated responses](https://developers.openai.com/api/docs/guides/realtime-conversations).

## Measured acceptance — 2026-10-15

These phase-1 measurements predate the incidental-speech classifier. They are not
measurements of phase-1.5 latency or classification accuracy.

Real headless Chrome WebRTC and live OpenAI calls completed all seven turns in one session/conversation, using synthetic Portuguese microphone audio and an isolated PostgreSQL database. Connection took 2.45 seconds. The temporary database was dropped afterwards; actual user financial data was not changed.

| Turn | First audible response after speech end | finance_turn duration | Through end of playback |
| ---- | --------------------------------------- | --------------------- | ----------------------- |
| Groceries this month | 11.02 s | 6.32 s | 18.47 s |
| Monthly insights | 4.70 s | 3.15 s | 21.59 s |
| Budget reduction | 1.66 s | 0.046 s | 32.00 s |
| Prepare 20 EUR SELF expense | 4.63 s | 3.05 s | 14.92 s |
| Explicit confirmation | 1.65 s | 0.039 s | 6.60 s |
| Explicit balance question | 1.55 s | 0.026 s | 5.95 s |
| Unrelated expense question | 10.61 s | 8.40 s | 15.27 s |

Preparation left only pending state. Confirmation created one expense with one exact SELF debit. The last unrelated answer disclosed no bank balance in either approved text or the provider's generated speech transcript. Playback duration includes speaking the complete answer; it is not backend processing duration. These measurements do not establish a uniform latency improvement: the retained financial chat orchestration remains significant for longer queries. Physical microphone quality, human listening and live barge-in still require user acceptance; mocked browser tests cover interruption state and cleanup.

## Changed-file inventory

Phase 1.5 creates realtime-turn-filter.service.ts and its unit spec under
src/ai/realtime/. It changes src/ai/ai.module.ts, src/ai/openai.config.ts,
.env.example, src/ai/realtime/realtime.service.ts, its unit spec,
realtime.transport.spec.ts, test/realtime.e2e-spec.ts and
frontend/test/realtime-client.test.mjs. This README, src/ai/README.md and root
VOICE.md document the filter. No frontend runtime, financial domain, AI chat
or legacy voice implementation is changed; no schema migration is needed.

Phase-1.5 automated checks passed: backend build, 524 unit tests, 222 e2e tests
and lint; frontend build, five tests and lint. Regression examples cover short
category follow-ups, active pending confirmations/cancellations, domestic side
conversation, ambiguous financial/balance utterances, interrupted playback,
classifier timeout/cancellation/invalid output, idle lifetime and text-chat
isolation. No live classifier accuracy or new audio latency measurement is
claimed by these mocked tests.

New backend files: realtime.controller.ts, realtime.dto.ts, realtime.service.ts, realtime.service.spec.ts, realtime.transport.ts, realtime.transport.spec.ts, realtime-tool.adapter.ts and this README under src/ai/realtime/, plus test/realtime.e2e-spec.ts.

Modified backend files: src/ai/ai.module.ts, src/ai/openai.config.ts, src/ai/openai.config.spec.ts, src/ai/README.md, src/ai/voice/audio.service.ts, src/ai/voice/audio.service.spec.ts, src/ai/voice/voice.controller.ts, src/ai/voice/voice.service.ts, .env.example, package.json and package-lock.json. Legacy implementation edits only mark its role; existing default-voice assertions were aligned with the configured cedar default. The actual .env was not edited.

New frontend files: src/RealtimeVoice.tsx, src/realtime-client.ts and test/realtime-client.test.mjs. Modified frontend files: src/App.tsx and package.json. Root VOICE.md links this optional runtime. No schema/migration changes.

Initial realtime validation: backend build, 421 unit tests, 199 e2e tests and lint passed; frontend build, four tests and lint passed. The subsequent renewable-inactivity change passed backend build, 431 unit tests, 200 e2e tests and lint. CI tests use mocks rather than live OpenAI connections. Lifecycle tests include incomplete handshake, missing transcription, stalled routing, shutdown during upstream session creation, idle expiry, polling without renewal, response/playback renewal and the absolute maximum. The reconnect e2e verifies that the same conversationId restores previous category/period messages for "E com pets?" and invokes the PETS backend query; the OpenAI response is mocked, so this establishes context delivery rather than guaranteeing live model interpretation.

## Cleanup inventory — only AFTER realtime acceptance

Nothing listed here is removed in this phase. Removal requires proving all supported legacy use cases have a realtime replacement, including unavailable-network/text fallback and the privacy checks above.

| Candidate                    | Exact scope / condition                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy HTTP transport        | src/ai/voice/voice.controller.ts and POST /ai/voice; remove its AiModule controller registration                                                                                                                                                                                                                                                                                  |
| Legacy pipeline              | src/ai/voice/voice.service.ts and provider registration                                                                                                                                                                                                                                                                                                                           |
| File audio adapter           | src/ai/voice/audio.service.ts and provider registration, including transcription, MP3 chunking, 15-second TTS deadline/error type, provider-error redaction and TTS logs                                                                                                                                                                                                          |
| Upload-only types/validation | src/ai/voice/audio.ts and voice.dto.ts, after checking no imports remain                                                                                                                                                                                                                                                                                                          |
| Legacy instrumentation       | src/ai/voice/voice-timing.ts, plus aiRound/timing imports/calls in AiService; frontend/src/voice-diagnostics.ts and its App imports/calls                                                                                                                                                                                                                                         |
| Legacy frontend              | MediaRecorder/chunks, upload FormData/fetch, upload AbortController, blob URL/MP3 playback, legacy timers/phase/error state and push-to-talk JSX in frontend/src/App.tsx; simplify the mode selector only after acceptance                                                                                                                                                        |
| Legacy env/config            | OPENAI_TRANSCRIBE_MODEL, OPENAI_TTS_MODEL, OPENAI_VOICE and corresponding OpenAIConfig fields, .env.example entries and validation tests, if no other consumer remains. Remove VOICE_DIAGNOSTICS_TRANSCRIPT/AI_PREPARE_DEBUG only if retiring that separate debugging workflow. VOICE_RUNTIME_MODE can go when a single runtime is the accepted default                           |
| Legacy tests                 | src/ai/voice/audio.service.spec.ts (move any shared speech/finance coverage first), src/ai/voice/voice-timing.spec.ts, test/voice.e2e-spec.ts and test/voice-tts-timeout.e2e-spec.ts. Remove the legacy-voice section of bank-accounts.e2e-spec.ts only after equivalent realtime privacy coverage                                                                                |
| Temporary measurements       | ignored backend/.tmp/measure-voice.mjs, measure-two-voice-turns.mjs, manual-tts-deadline.mjs and their WAV/JSON files. New validation helpers generate-rt-fixtures.mjs, generate-rt-stream-fixtures.mjs, validate-realtime-browser.mjs, rt-phrase-* samples, realtime-browser-* Chrome profiles and realtime-browser-report.json can be removed after preserving accepted results |
| Documentation                | Legacy upload/transcription/TTS/timeout/debug sections in root VOICE.md and voice paragraphs in src/ai/README.md; retain current realtime docs and migration/financial-domain history                                                                                                                                                                                             |
| Dependencies                 | ws and @types/ws were added for the SDK's header-authenticated Node sideband; KEEP them for realtime. No dependency is automatically removable with legacy: OpenAI, NestJS/platform-express, React and TypeScript are shared. Audit multipart-only transitive usage after removing FileInterceptor; do not delete shared packages blindly                                         |

KEEP: AiService/financeTools, all financial modules, pending-confirmation/idempotency logic, Conversation services, Prisma, OPENAI_CHAT_MODEL/OPENAI_CLASSIFICATION_MODEL, and voice/speech-money.ts + speech-date.ts (reused here). The common ai-chat-diagnostics helper is separate chat instrumentation; retiring legacy voice alone does not justify deleting it.
