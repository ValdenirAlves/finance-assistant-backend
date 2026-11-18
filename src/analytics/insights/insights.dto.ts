import { IsEnum, IsOptional } from 'class-validator';
import { Currency, ExpenseCategory } from '../../generated/prisma/enums.js';
export enum InsightType {
  BUDGET_AT_RISK = 'BUDGET_AT_RISK',
  BUDGET_EXCEEDED = 'BUDGET_EXCEEDED',
  CATEGORY_SPEND_SPIKE = 'CATEGORY_SPEND_SPIKE',
  RECURRING_EXPENSE_INCREASE = 'RECURRING_EXPENSE_INCREASE',
  MONTH_OVER_MONTH_INCREASE = 'MONTH_OVER_MONTH_INCREASE',
}
export enum InsightSeverity {
  INFO = 'INFO',
  WARNING = 'WARNING',
  CRITICAL = 'CRITICAL',
}
export class InsightsDto {
  @IsOptional() @IsEnum(Currency) currency?: Currency;
  @IsOptional() @IsEnum(ExpenseCategory) category?: ExpenseCategory;
  @IsOptional() @IsEnum(InsightType) type?: InsightType;
  @IsOptional() @IsEnum(InsightSeverity) severity?: InsightSeverity;
}
export interface ComparisonPeriods {
  effectiveDate: string;
  current: { from: string; to: string };
  previous: { from: string; to: string };
}
interface BudgetData {
  budgetId: string;
  budgetAmount: string;
  spent: string;
  remaining: string;
  percentageUsed: string;
  overage: string;
  projectedMonthTotal: string | null;
  projectedOverage: string | null;
  scope: { merchant: string | null; category: ExpenseCategory | null };
}
interface ComparisonData {
  previousAmount: string;
  currentAmount: string;
  increaseAmount: string;
  increasePercentage: string;
  periods: ComparisonPeriods;
}
interface RecurringData {
  merchant: string;
  category: ExpenseCategory;
  previousAmount: string;
  latestAmount: string;
  increaseAmount: string;
  increasePercentage: string;
  latestChargeDate: string;
  priorOccurrences: number;
}
interface BaseInsight {
  id: string;
  severity: InsightSeverity;
  currency: Currency;
  title: string;
}
export type FinancialInsight = BaseInsight &
  (
    | {
        type: InsightType.BUDGET_AT_RISK | InsightType.BUDGET_EXCEEDED;
        data: BudgetData;
      }
    | {
        type: InsightType.CATEGORY_SPEND_SPIKE;
        data: ComparisonData & { category: ExpenseCategory };
      }
    | { type: InsightType.MONTH_OVER_MONTH_INCREASE; data: ComparisonData }
    | { type: InsightType.RECURRING_EXPENSE_INCREASE; data: RecurringData }
  );
export function comparisonPeriods(now: Date): ComparisonPeriods {
  const currentStart = new Date(now);
  currentStart.setUTCHours(0, 0, 0, 0);
  currentStart.setUTCDate(1);
  const previousStart = new Date(currentStart);
  previousStart.setUTCMonth(previousStart.getUTCMonth() - 1);
  const lastPrevious = new Date(currentStart.getTime() - 1).getUTCDate();
  const previousEnd = new Date(previousStart);
  previousEnd.setUTCDate(Math.min(now.getUTCDate(), lastPrevious));
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  return {
    effectiveDate: iso(now),
    current: { from: iso(currentStart), to: iso(now) },
    previous: { from: iso(previousStart), to: iso(previousEnd) },
  };
}
