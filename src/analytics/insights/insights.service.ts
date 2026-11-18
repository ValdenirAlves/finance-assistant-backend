import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Prisma } from '../../generated/prisma/client.js';
import { Currency } from '../../generated/prisma/enums.js';
import { BudgetsService } from '../../budgets/budgets.service.js';
import { AnalyticsService } from '../analytics.service.js';
import { RecurringExpensesService } from '../recurring-expenses.service.js';
import {
  detectRecurringExpenses,
  recurringAmountStats,
} from '../recurring-expenses.js';
import {
  normalizeMerchant,
  categoryLabel,
} from '../../categories/categories.service.js';
import {
  comparisonPeriods,
  InsightSeverity,
  InsightType,
  InsightsDto,
} from './insights.dto.js';
import type { FinancialInsight } from './insights.dto.js';
const Decimal = Prisma.Decimal.clone({ precision: 40 });
import {
  measureDiagnostic,
  diagnostic,
} from '../../common/ai-chat-diagnostics.js';
@Injectable()
export class InsightsService {
  constructor(
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
    @Inject(BudgetsService) private readonly budgets: BudgetsService,
    @Inject(RecurringExpensesService)
    private readonly recurring: RecurringExpensesService,
  ) {}
  async findAll(input: InsightsDto = {}) {
    return measureDiagnostic('insights.total', () =>
      this.analyzeInsights(input),
    );
  }
  private async analyzeInsights(input: InsightsDto) {
    const dto = plainToInstance(InsightsDto, input);
    if (
      validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).length
    )
      throw new BadRequestException('Invalid insight filters');
    const now = this.analytics.currentDate();
    const periods = comparisonPeriods(now);
    const [current, previous, budgets, recurrence] = await Promise.all([
      measureDiagnostic('insights.current_category_query', () =>
        this.analytics.byCategory(periods.current),
      ),
      measureDiagnostic('insights.previous_category_query', () =>
        this.analytics.byCategory(periods.previous),
      ),
      measureDiagnostic('insights.budget_list', () => this.budgets.findAll()),
      measureDiagnostic(
        'insights.recurring_load',
        () =>
          this.recurring.analyze({
            to: periods.current.to,
            currency: dto.currency,
            category: dto.category,
          }),
        { from: null, to: periods.current.to },
      ),
    ]);
    const insights: FinancialInsight[] = [];
    diagnostic('insights.input_sizes', {
      budgets: budgets.length,
      recurringRows: recurrence.rows.length,
      recurringCandidates: recurrence.candidates.length,
      currentGroups: current.length,
      previousGroups: previous.length,
    });
    let phaseStarted = performance.now();
    for (const budget of budgets) {
      if (
        budget.year !== now.getUTCFullYear() ||
        budget.month !== now.getUTCMonth() + 1 ||
        (dto.currency && budget.currency !== dto.currency) ||
        (dto.category && budget.category !== dto.category)
      )
        continue;
      const status = await measureDiagnostic('insights.budget_status', () =>
        this.budgets.status(budget.id, now),
      );
      const type =
        status.status === 'OVER_BUDGET'
          ? InsightType.BUDGET_EXCEEDED
          : status.projectedOverBudget
            ? InsightType.BUDGET_AT_RISK
            : null;
      if (!type) continue;
      insights.push({
        id: `${type}:${budget.id}`,
        type,
        severity:
          type === InsightType.BUDGET_EXCEEDED
            ? InsightSeverity.CRITICAL
            : InsightSeverity.WARNING,
        currency: budget.currency,
        title: `${budget.merchant ?? categoryLabel(budget.category!, false)} budget ${type === InsightType.BUDGET_EXCEEDED ? 'exceeded' : 'at risk'}`,
        data: {
          budgetId: budget.id,
          budgetAmount: status.budgetAmount,
          spent: status.spent,
          remaining: status.remaining,
          percentageUsed: status.percentageUsed,
          overage: status.overage,
          projectedMonthTotal: status.projectedMonthTotal,
          projectedOverage: status.projectedOverage,
          scope: { merchant: budget.merchant, category: budget.category },
        },
      });
    }
    const previousByCategory = new Map(
      // Budget phase contains serial status lookups; measure before optimization.
      previous.map((row) => [`${row.currency}:${row.category}`, row.total]),
    );
    diagnostic('insights.budget_analysis', {
      durationMs: performance.now() - phaseStarted,
    });
    phaseStarted = performance.now();
    const currentTotals = { EUR: new Decimal('0'), BRL: new Decimal('0') },
      previousTotals = { EUR: new Decimal('0'), BRL: new Decimal('0') };
    for (const row of previous)
      previousTotals[row.currency] = previousTotals[row.currency].plus(
        row.total,
      );
    for (const row of current) {
      currentTotals[row.currency] = currentTotals[row.currency].plus(row.total);
      const base = new Decimal(
        previousByCategory.get(`${row.currency}:${row.category}`) ?? '0',
      );
      const increase = new Decimal(row.total).minus(base);
      if (!base.gt('0') || !increase.gte('20')) continue;
      const percentage = increase.div(base).mul('100');
      if (!percentage.gte('30')) continue;
      insights.push({
        id: `CATEGORY_SPEND_SPIKE:${row.currency}:${row.category}`,
        type: InsightType.CATEGORY_SPEND_SPIKE,
        severity: percentage.gte('50')
          ? InsightSeverity.CRITICAL
          : InsightSeverity.WARNING,
        currency: row.currency,
        title: `${categoryLabel(row.category, false)} spending increased`,
        data: {
          category: row.category,
          previousAmount: base.toFixed(2),
          currentAmount: row.total,
          increaseAmount: increase.toFixed(2),
          increasePercentage: percentage.toFixed(2),
          periods,
        },
      });
    }
    diagnostic('insights.category_spike_analysis', {
      durationMs: performance.now() - phaseStarted,
    });
    phaseStarted = performance.now();
    for (const currency of [Currency.EUR, Currency.BRL]) {
      const base = previousTotals[currency],
        increase = currentTotals[currency].minus(base);
      if (!base.gt('0') || !increase.gte('50')) continue;
      const percentage = increase.div(base).mul('100');
      if (!percentage.gte('25')) continue;
      insights.push({
        id: `MONTH_OVER_MONTH_INCREASE:${currency}`,
        type: InsightType.MONTH_OVER_MONTH_INCREASE,
        severity: percentage.gte('50')
          ? InsightSeverity.CRITICAL
          : InsightSeverity.WARNING,
        currency,
        title: 'Month-to-date spending increased',
        data: {
          previousAmount: base.toFixed(2),
          currentAmount: currentTotals[currency].toFixed(2),
          increaseAmount: increase.toFixed(2),
          increasePercentage: percentage.toFixed(2),
          periods,
        },
      });
    }
    diagnostic('insights.month_over_month_analysis', {
      durationMs: performance.now() - phaseStarted,
    });
    phaseStarted = performance.now();
    for (const candidate of recurrence.candidates) {
      if (
        candidate.confidence === 'LOW' ||
        candidate.lastChargeDate < periods.current.from ||
        candidate.lastChargeDate > periods.current.to
      )
        continue;
      const rows = recurrence.rows
        .filter(
          (row) =>
            row.currency === candidate.currency &&
            row.category === candidate.category &&
            row.merchant &&
            normalizeMerchant(row.merchant) === candidate.normalizedMerchant,
        )
        .sort(
          (a, b) =>
            a.transactionDate.getTime() - b.transactionDate.getTime() ||
            a.id.localeCompare(b.id),
        );
      const latest = rows.at(-1);
      if (!latest) continue;
      const baseline = detectRecurringExpenses(rows.slice(0, -1))[0];
      const baselineStats = recurringAmountStats(rows.slice(0, -1));
      if (!baseline || baselineStats.variation.gt('10')) continue;
      const previousAmount = baselineStats.average,
        latestAmount = new Decimal(latest.amount),
        increase = latestAmount.minus(previousAmount);
      if (!previousAmount.gt('0') || !increase.gte('1')) continue;
      const percentage = increase.div(previousAmount).mul('100');
      if (!percentage.gte('10')) continue;
      insights.push({
        id: `RECURRING_EXPENSE_INCREASE:${candidate.normalizedMerchant}:${candidate.currency}:${candidate.category}`,
        type: InsightType.RECURRING_EXPENSE_INCREASE,
        severity: InsightSeverity.WARNING,
        currency: candidate.currency,
        title: `Recurring charge increased: ${candidate.merchant}`,
        data: {
          merchant: candidate.merchant,
          category: candidate.category,
          previousAmount: previousAmount.toFixed(2),
          latestAmount: latestAmount.toFixed(2),
          increaseAmount: increase.toFixed(2),
          increasePercentage: percentage.toFixed(2),
          latestChargeDate: candidate.lastChargeDate,
          priorOccurrences: baseline.occurrences,
        },
      });
    }
    const rank = { CRITICAL: 0, WARNING: 1, INFO: 2 };
    diagnostic('insights.recurring_analysis', {
      durationMs: performance.now() - phaseStarted,
    });
    const category = (insight: FinancialInsight) =>
      insight.type === InsightType.BUDGET_AT_RISK ||
      insight.type === InsightType.BUDGET_EXCEEDED
        ? insight.data.scope.category
        : 'category' in insight.data
          ? insight.data.category
          : null;
    return insights
      .filter(
        (row) =>
          (!dto.currency || row.currency === dto.currency) &&
          (!dto.category || category(row) === dto.category) &&
          (!dto.severity || row.severity === dto.severity) &&
          (!dto.type || row.type === dto.type),
      )
      .sort(
        (a, b) =>
          rank[a.severity] - rank[b.severity] ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
  }
  async summary(input: InsightsDto = {}) {
    const rows = await this.findAll(input);
    return {
      critical: rows.filter((row) => row.severity === InsightSeverity.CRITICAL)
        .length,
      warning: rows.filter((row) => row.severity === InsightSeverity.WARNING)
        .length,
      info: rows.filter((row) => row.severity === InsightSeverity.INFO).length,
    };
  }
}
