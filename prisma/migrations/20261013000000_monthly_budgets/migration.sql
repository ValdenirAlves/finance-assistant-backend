ALTER TABLE "Expense" ADD COLUMN "category" TEXT;
CREATE TABLE "Budget" (
 "id" UUID NOT NULL, "amount" DECIMAL(19,2) NOT NULL, "currency" "Currency" NOT NULL,
 "year" INTEGER NOT NULL, "month" INTEGER NOT NULL, "merchant" TEXT, "category" TEXT, "scopeKey" TEXT NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL,
 CONSTRAINT "Budget_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "Budget_valid" CHECK ("amount" > 0 AND "year" BETWEEN 1 AND 9999 AND "month" BETWEEN 1 AND 12 AND (("merchant" IS NOT NULL)::int + ("category" IS NOT NULL)::int = 1)),
 CONSTRAINT "Budget_scope" CHECK ("scopeKey" = CASE WHEN "merchant" IS NOT NULL THEN 'merchant:' || lower(btrim("merchant")) ELSE 'category:' || lower(btrim("category")) END)
);
CREATE UNIQUE INDEX "Budget_year_month_currency_scopeKey_key" ON "Budget"("year","month","currency","scopeKey");
CREATE TABLE "PendingBudget" (
 "id" UUID NOT NULL, "conversationId" UUID NOT NULL, "amount" DECIMAL(19,2) NOT NULL, "currency" "Currency" NOT NULL,
 "year" INTEGER NOT NULL, "month" INTEGER NOT NULL, "merchant" TEXT, "category" TEXT,
 "status" "PendingExpenseStatus" NOT NULL DEFAULT 'PENDING', "revision" INTEGER NOT NULL DEFAULT 1,
 "confirmationRequested" BOOLEAN NOT NULL DEFAULT false, "budgetId" UUID,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL,
 CONSTRAINT "PendingBudget_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "PendingBudget_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "PendingBudget_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "Budget"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PendingBudget_conversationId_key" ON "PendingBudget"("conversationId");
CREATE UNIQUE INDEX "PendingBudget_budgetId_key" ON "PendingBudget"("budgetId");
