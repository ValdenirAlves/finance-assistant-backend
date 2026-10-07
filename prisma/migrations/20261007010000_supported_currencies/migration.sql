-- Preserve original amounts and currency codes. Unsupported existing codes must
-- be resolved explicitly before this migration; never silently convert them.
CREATE TYPE "Currency" AS ENUM ('EUR', 'BRL');

ALTER TABLE "Expense"
ALTER COLUMN "currency" TYPE "Currency"
USING ("currency"::"Currency");
