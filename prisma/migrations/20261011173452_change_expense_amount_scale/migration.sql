/*
  Warnings:

  - You are about to alter the column `amount` on the `Expense` table. The data in that column could be lost. The data in that column will be cast from `Decimal(19,4)` to `Decimal(19,2)`.
  - You are about to alter the column `amount` on the `PendingExpense` table. The data in that column could be lost. The data in that column will be cast from `Decimal(19,4)` to `Decimal(19,2)`.

*/
-- AlterTable
ALTER TABLE "Expense" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(19,2);

-- AlterTable
ALTER TABLE "PendingExpense" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(19,2);
