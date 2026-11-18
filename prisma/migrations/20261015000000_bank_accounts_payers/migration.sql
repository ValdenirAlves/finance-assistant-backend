-- Historical expenses retain unknown payer; no default or retroactive debit.
CREATE TYPE "ExpensePayer" AS ENUM ('SELF', 'SPOUSE');
CREATE TYPE "AccountOwner" AS ENUM ('SELF');
ALTER TABLE "Expense" ADD COLUMN "payer" "ExpensePayer";
ALTER TABLE "PendingExpense" ADD COLUMN "payer" "ExpensePayer";
CREATE TABLE "BankAccount" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "currency" "Currency" NOT NULL,
  "currentBalance" DECIMAL(19,2) NOT NULL,
  "owner" "AccountOwner" NOT NULL DEFAULT 'SELF',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BankAccount_owner_currency_key" ON "BankAccount"("owner", "currency");
CREATE TABLE "PendingBankBalance" (
  "id" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "name" TEXT,
  "currency" "Currency" NOT NULL,
  "currentBalance" DECIMAL(19,2) NOT NULL,
  "status" "PendingExpenseStatus" NOT NULL DEFAULT 'PENDING',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "confirmationRequested" BOOLEAN NOT NULL DEFAULT false,
  "accountId" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "PendingBankBalance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PendingBankBalance_conversationId_key" ON "PendingBankBalance"("conversationId");
ALTER TABLE "PendingBankBalance" ADD CONSTRAINT "PendingBankBalance_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
