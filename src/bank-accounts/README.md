# Personal bank accounts and confirmed balance updates

BankAccount stores UUID id, name, EUR/BRL currency, owner SELF, currentBalance DECIMAL(19,2), createdAt and updatedAt. There is one SELF account per currency (unique owner/currency), allowing an EUR and a BRL account without conversion or shared totals. Names label accounts, not separate accounts of the same currency. Payment method is deferred.

Balances accept signed decimal strings with at most 17 integer/two fractional digits, including zero/negative balances. JSON numbers, exponent notation and excess precision are rejected rather than rounded. Output uses exactly two decimal places. No zero account is created implicitly. Updating an unnamed existing account preserves its name; a new unnamed account is named Personal. Balance writes set an absolute user-reported balance, not an income/deposit ledger. They do not recalculate from past expenses.

## API

The smaller API uses dedicated draft/confirmation endpoints so every balance mutation requires a separate explicit action:

| Method/path | Contract |
|---|---|
| GET /bank-accounts | List personal accounts; optional currency and account (case-insensitive exact name) filters |
| GET /bank-accounts/:id | Read one account, 404 if absent; malformed UUID => 400 |
| POST /bank-accounts/balance-updates | Prepare an update; never changes BankAccount |
| POST /bank-accounts/balance-updates/confirm | Confirm a previously returned conversationId/revision |
| POST /bank-accounts/balance-updates/cancel | Cancel that pending conversationId/revision |

Preparation body (conversationId may refer to an existing chat; omit it to create a new confirmation context without OpenAI):

```json
{"conversationId":"<uuid>","name":"AIB","currency":"EUR","currentBalance":"3250.00"}
```

Response: conversationId, revision, status PENDING, currency, name and two-decimal currentBalance. Name and conversationId are optional on preparation. Confirm/cancel body:

```json
{"conversationId":"<uuid>","revision":1}
```

Successful confirm returns only `{"status":"CONFIRMED"}`; cancel returns CANCELLED. Stale revision => 409; cancelled/unreviewed confirmation => 400. Read endpoints return currentBalance as a string; direct API reads are explicit balance requests. As with the existing personal application, authentication/conversation ownership is not introduced in this milestone.

## Chat and voice

"Meu saldo no AIB é 3250 euros.", "Atualize meu saldo para 3100 euros." and "Tenho 2800 euros na conta." prepare drafts through a validated tool. Only a later explicit "Pode salvar" commits. "Qual meu saldo?" authorizes a deterministic fresh read. Conservative Portuguese/English current-turn intent recognition defaults to no balance access. Corrections outside these recognized explicit declarations should repeat the balance-setting request.

Bank balance is private: do not volunteer it in expenses, budgets, projections, recurring expenses, insights, or TTS. History never grants later access. Private balance interactions are redacted in persisted visible conversation history; the UI still receives their authorized response. Model instructions, tool availability/dispatch restrictions, deterministic reads and history filtering enforce this separation. Generic confirmations reveal no resulting balance. Voice uses the same service and response before speech formatting.

## Atomicity and idempotency

Balance preparation locks the conversation, checks expected revision and cancels competing pending expense/budget writes. Confirmation locks the conversation, upserts its matching-currency account and marks the draft confirmed in one transaction. A repeated confirmation returns status without reapplying an old absolute balance. An intervening unrelated turn disarms a pending balance; the next yes requests confirmation again without quoting it.

Expense payer controls balance impact. New final expenses require SELF/SPOUSE. SELF uses a PostgreSQL atomic Decimal decrement on the matching SELF currency account within the same transaction as expense creation. Pending expense confirmation also saves confirmed state and category mapping there. Failure rolls back all writes. Missing account => clear 400, no expense, no currency conversion. SPOUSE never mutates accounts and still participates in every analytics, category, budget, pace, recurring and insight result. Negative resulting balance is allowed; no overdraft policy is added.

The existing pending expense lock/revision/expenseId protects against repeated confirmations. A potential duplicate first requires explicit override; a repeated override does not insert/debit twice. Independent manual POST /expenses requests remain independent creations.

## Migration and verification

`20261015000000_bank_accounts_payers` adds both bank models, AccountOwner/ExpensePayer enums and nullable payer to Expense/PendingExpense. Historical unknown payers stay null, without a default SELF, guessed ownership, retroactive debits or financial data rewriting. New unresolved AI drafts can be stored but cannot confirm. Apply with `npm run prisma:deploy`, then regenerate the client.

Automated unit/e2e tests run real domain/controller logic with stateful, rollback-capable Prisma doubles and mocked OpenAI/audio. They cover Decimal precision, confirmation/cancellation, atomic rollback, currencies, unknown payer, duplicate/repeat confirmations and text/voice privacy. Existing analytics/budget/category/recurrence suites remain in place; spouse expenses are not excluded.

## Files in this milestone

Paths below are relative to backend unless stated otherwise.

| Area | Created/updated files |
|---|---|
| Bank domain (new) | src/bank-accounts/bank-accounts.module.ts, bank-accounts.controller.ts, bank-accounts.service.ts, bank-balance.dto.ts, bank-accounts.service.spec.ts and README.md |
| Persistence | prisma/schema.prisma; prisma/migrations/20261015000000_bank_accounts_payers/migration.sql (new); regenerated src/generated/prisma/ client, enums and model types |
| Module wiring | src/app.module.ts, src/ai/ai.module.ts |
| AI | src/ai/ai.service.ts, ai.tools.ts, expense-intent.ts, expense-intent.spec.ts; new balance-privacy.ts and balance-privacy.spec.ts |
| Domain changes | src/expenses/expenses.service.ts, src/expenses/dto/create-expense.dto.ts, src/pending-expenses/pending-expense.service.ts, src/budgets/budgets.service.ts |
| Existing unit fixtures | src/expenses/expenses.service.spec.ts, src/expenses/expense-duplicates.spec.ts, src/pending-expenses/pending-expense.service.spec.ts, src/categories/categories.service.spec.ts |
| HTTP tests | new test/bank-accounts.e2e-spec.ts; updated test/expenses.e2e-spec.ts, test/categories.e2e-spec.ts, test/ai.e2e-spec.ts, test/ai-write.e2e-spec.ts |
| Stateful doubles | new test/helpers/bank-state.ts; updated test/helpers/pending-database.ts and budget-database.ts |
| Durable documentation | repository-root AGENTS.md, src/expenses/README.md, src/ai/README.md and this README |

The applied PostgreSQL migration and schema diff were checked locally. A separate diagnostic transaction exercised real ExpensesService writes against PostgreSQL: exact SELF decrement, no SPOUSE debit and rollback of both account/expense changes passed, leaving no persisted financial changes. No real OpenAI call was needed for automated verification. Frontend and analytics formulas were not changed.
