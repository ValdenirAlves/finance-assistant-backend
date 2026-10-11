-- CreateEnum
CREATE TYPE "PendingExpenseStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED');

-- CreateTable
CREATE TABLE "PendingExpense" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "currency" "Currency" NOT NULL,
    "description" TEXT,
    "merchant" TEXT,
    "transactionDate" TIMESTAMPTZ(3) NOT NULL,
    "status" "PendingExpenseStatus" NOT NULL DEFAULT 'PENDING',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "confirmationRequested" BOOLEAN NOT NULL DEFAULT false,
    "expenseId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PendingExpense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PendingExpense_conversationId_key" ON "PendingExpense"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "PendingExpense_expenseId_key" ON "PendingExpense"("expenseId");

-- AddForeignKey
ALTER TABLE "PendingExpense" ADD CONSTRAINT "PendingExpense_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingExpense" ADD CONSTRAINT "PendingExpense_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE SET NULL ON UPDATE CASCADE;
