# Categories and merchant mappings

ExpenseCategory is required on Expense and PendingExpense. Budget/PendingBudget category scopes use the same enum. Portuguese/English display labels are fixed in categoryLabels; storage and filters use enum codes.

CategoriesService normalizes merchant with trim and lowercase and performs exact persisted mapping lookup. Seeds: Tesco/Lidl/Aldi -> GROCERIES; Netflix -> SUBSCRIPTIONS; Pet Stop/Maxi Zoo -> PETS. No fuzzy matching. Only unknown merchants use structured AI fallback during preparation; uncertainty or unavailable classification becomes OTHER. Backend rejects arbitrary category codes.

Mappings are learned only when confirming the expense, in the same transaction as the Expense and pending status. createMany(skipDuplicates) keeps existing mappings immutable even under races. A concurrent mapping may already exist with a different category; it is never overwritten, and the confirmed expense retains its reviewed category. No update-category feature is introduced.

Migration 20261013010000_expense_categories keeps all financial rows, preserves valid preexisting enum-compatible expense categories, backfills obvious mappings for otherwise OTHER expenses, and assigns OTHER to ambiguous merchants such as Santander. Pending expense confirmations are disarmed when category was backfilled, requiring another review. Legacy budget category labels are preserved in LegacyBudgetCategory before conversion; a uniqueness collision aborts the entire migration. No data is deleted or budgets merged.
