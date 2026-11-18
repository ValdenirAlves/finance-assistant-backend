BEGIN;
CREATE TYPE "ExpenseCategory" AS ENUM ('GROCERIES','RESTAURANTS','TRANSPORT','FUEL','UTILITIES','RENT','SUBSCRIPTIONS','HEALTH','PETS','SHOPPING','ENTERTAINMENT','OTHER');
CREATE TABLE "MerchantCategoryMapping" (
 "id" UUID NOT NULL, "normalizedMerchant" TEXT NOT NULL, "category" "ExpenseCategory" NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL,
 CONSTRAINT "MerchantCategoryMapping_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MerchantCategoryMapping_normalizedMerchant_key" ON "MerchantCategoryMapping"("normalizedMerchant");
INSERT INTO "MerchantCategoryMapping" ("id","normalizedMerchant","category","updatedAt") VALUES
 ('00000000-0000-4000-8000-000000000001','tesco','GROCERIES',CURRENT_TIMESTAMP),
 ('00000000-0000-4000-8000-000000000002','lidl','GROCERIES',CURRENT_TIMESTAMP),
 ('00000000-0000-4000-8000-000000000003','aldi','GROCERIES',CURRENT_TIMESTAMP),
 ('00000000-0000-4000-8000-000000000004','netflix','SUBSCRIPTIONS',CURRENT_TIMESTAMP),
 ('00000000-0000-4000-8000-000000000005','pet stop','PETS',CURRENT_TIMESTAMP),
 ('00000000-0000-4000-8000-000000000006','maxi zoo','PETS',CURRENT_TIMESTAMP);
ALTER TABLE "Expense" ALTER COLUMN "category" TYPE "ExpenseCategory" USING
 CASE WHEN upper("category") IN ('GROCERIES','RESTAURANTS','TRANSPORT','FUEL','UTILITIES','RENT','SUBSCRIPTIONS','HEALTH','PETS','SHOPPING','ENTERTAINMENT','OTHER') THEN upper("category")::"ExpenseCategory" ELSE 'OTHER'::"ExpenseCategory" END;
UPDATE "Expense" e SET "category" = m."category" FROM "MerchantCategoryMapping" m WHERE lower(btrim(e."merchant")) = m."normalizedMerchant" AND e."category"='OTHER';
ALTER TABLE "Expense" ALTER COLUMN "category" SET DEFAULT 'OTHER', ALTER COLUMN "category" SET NOT NULL;
ALTER TABLE "PendingExpense" ADD COLUMN "category" "ExpenseCategory" NOT NULL DEFAULT 'OTHER';
UPDATE "PendingExpense" e SET "category" = m."category", "confirmationRequested" = false FROM "MerchantCategoryMapping" m WHERE lower(btrim(e."merchant")) = m."normalizedMerchant";
-- Preserve unknown legacy category labels in a backup before normalizing them.
CREATE TABLE "LegacyBudgetCategory" AS SELECT 'Budget'::text AS "source", "id", "category" FROM "Budget" WHERE "category" IS NOT NULL UNION ALL SELECT 'PendingBudget', "id", "category" FROM "PendingBudget" WHERE "category" IS NOT NULL;
ALTER TABLE "LegacyBudgetCategory" ALTER COLUMN "source" SET NOT NULL, ALTER COLUMN "id" SET NOT NULL, ALTER COLUMN "category" SET NOT NULL, ADD CONSTRAINT "LegacyBudgetCategory_pkey" PRIMARY KEY ("source", "id");
ALTER TABLE "Budget" DROP CONSTRAINT "Budget_scope";
ALTER TABLE "Budget" ALTER COLUMN "category" TYPE "ExpenseCategory" USING CASE WHEN "category" IS NULL THEN NULL WHEN upper("category") IN ('GROCERIES','RESTAURANTS','TRANSPORT','FUEL','UTILITIES','RENT','SUBSCRIPTIONS','HEALTH','PETS','SHOPPING','ENTERTAINMENT','OTHER') THEN upper("category")::"ExpenseCategory" ELSE 'OTHER'::"ExpenseCategory" END;
-- Category labels that collapse to OTHER could collide. Keep each existing budget, then abort if review is needed; never delete rows.
UPDATE "Budget" SET "scopeKey" = 'category:' || lower("category"::text) WHERE "category" IS NOT NULL;
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_scope" CHECK ("scopeKey" = CASE WHEN "merchant" IS NOT NULL THEN 'merchant:' || lower(btrim("merchant")) ELSE 'category:' || lower("category"::text) END);
ALTER TABLE "PendingBudget" ALTER COLUMN "category" TYPE "ExpenseCategory" USING CASE WHEN "category" IS NULL THEN NULL WHEN upper("category") IN ('GROCERIES','RESTAURANTS','TRANSPORT','FUEL','UTILITIES','RENT','SUBSCRIPTIONS','HEALTH','PETS','SHOPPING','ENTERTAINMENT','OTHER') THEN upper("category")::"ExpenseCategory" ELSE 'OTHER'::"ExpenseCategory" END;
UPDATE "PendingBudget" SET "confirmationRequested"=false WHERE "status"='PENDING';
COMMIT;
