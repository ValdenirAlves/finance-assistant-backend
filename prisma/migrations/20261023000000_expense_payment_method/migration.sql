CREATE TYPE "PaymentMethod" AS ENUM ('CARD', 'BANK_ACCOUNT', 'CASH', 'OTHER');
ALTER TABLE "Expense" ADD COLUMN "paymentMethod" "PaymentMethod";
ALTER TABLE "PendingExpense" ADD COLUMN "paymentMethod" "PaymentMethod";
-- Incomplete drafts are valid conversation state, never valid final Expenses.
ALTER TABLE "PendingExpense" ALTER COLUMN "amount" DROP NOT NULL,
  ALTER COLUMN "currency" DROP NOT NULL,
  ALTER COLUMN "transactionDate" DROP NOT NULL;
