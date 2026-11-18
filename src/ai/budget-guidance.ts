import {
  categoryLabel,
  categoryLabels,
  normalizeMerchant,
} from '../categories/categories.service.js';
import { Currency, ExpenseCategory } from '../generated/prisma/enums.js';
import { BudgetGuidanceState } from '../budgets/budget-pace.js';
import type { BudgetsService } from '../budgets/budgets.service.js';
import type { BudgetScopeDto } from '../budgets/dto/create-budget.dto.js';
type BudgetIdentity = Pick<
  Awaited<ReturnType<BudgetsService['findAll']>>[number],
  'id' | 'year' | 'month' | 'currency' | 'merchant' | 'category'
>;
type Message = { role: string; content: string };
const text = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
export function isBudgetGuidance(message: string) {
  const value = text(message).trim();
  if (!/^(quanto|como|qual|e\b|how|what|and\b|can i)\b/.test(value))
    return false;
  return (
    /\b(reduzir|reducao|reduce|reduction|cut)\b/.test(value) ||
    /(?:posso|can i|allowed|budget).*(?:por dia|por semana|per day|per week|daily|weekly)/.test(
      value,
    ) ||
    /^(?:e|and)\b.*(?:por semana|per week)/.test(value) ||
    /(?:ritmo.*fim do mes|ficar dentro.*orcamento|stay within.*budget)/.test(
      value,
    )
  );
}
export function guidancePortuguese(message: string) {
  return /\b(quanto|como|qual|reduzir|gastos|orcamento|dia|semana|ritmo)\b/.test(
    text(message),
  );
}
const aliases: Partial<Record<ExpenseCategory, string[]>> = {
  GROCERIES: ['mercado', 'supermercados', 'supermarket', 'supermarkets'],
  PETS: ['animais', 'pet shop'],
  SUBSCRIPTIONS: ['assinatura', 'subscription'],
};
function mentions(value: string, target: string) {
  const escaped = text(normalizeMerchant(target)).replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&',
  );
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`,
    'u',
  ).test(text(value));
}
function matching(budgets: BudgetIdentity[], content: string) {
  return budgets.filter((budget) =>
    budget.merchant
      ? mentions(content, budget.merchant)
      : [
          ...categoryLabels[budget.category!],
          ...(aliases[budget.category!] ?? []),
          budget.category!,
        ].some((label) => mentions(content, label)),
  );
}
export function resolveGuidanceBudget(
  message: string,
  history: Message[],
  budgets: BudgetIdentity[],
  now: Date,
): BudgetScopeDto | null {
  let active = budgets.filter(
    (row) =>
      row.year === now.getUTCFullYear() && row.month === now.getUTCMonth() + 1,
  );
  const filterCurrency = (rows: BudgetIdentity[], content: string) => {
    const eur = /\b(eur|euros?)\b/.test(text(content)),
      brl = /\b(brl|reais|real|brazilian reais)\b/.test(text(content));
    return eur !== brl
      ? rows.filter(
          (row) => row.currency === (eur ? Currency.EUR : Currency.BRL),
        )
      : rows;
  };
  active = filterCurrency(active, message);
  const explicit = matching(active, message);
  let candidates = explicit;
  if (!explicit.length) {
    if (
      matching(budgets, message).length ||
      /\b(?:no|na|at|for)\s+(?!orcamento\b|budget\b|fim\b|end\b|mes\b|month\b)[\p{L}]+/u.test(
        text(message),
      )
    )
      return null;
    const recent = history
      .slice(-2)
      .map((row) => row.content)
      .join('\n');
    if (!/\b(orcamento|budget)\b/.test(text(recent))) return null;
    const explicitCurrency = /\b(eur|euros?|brl|reais|real)\b/.test(
      text(message),
    );
    candidates = explicitCurrency
      ? matching(active, recent)
      : filterCurrency(matching(active, recent), recent);
  }
  if (candidates.length !== 1) return null;
  const row = candidates[0];
  return {
    year: row.year,
    month: row.month,
    currency: row.currency,
    merchant: row.merchant ?? undefined,
    category: row.category ?? undefined,
  };
}
export function formatBudgetGuidance(
  status: Awaited<ReturnType<BudgetsService['status']>>,
  message: string,
) {
  const pt = guidancePortuguese(message),
    scope = status.merchant ?? categoryLabel(status.category!, pt),
    currency = status.currency;
  if (status.paceGuidanceState === BudgetGuidanceState.UNAVAILABLE)
    return pt
      ? 'A orientação de ritmo está disponível apenas para um orçamento do mês atual.'
      : 'Pace guidance is available only for a current-month budget.';
  if (status.paceGuidanceState === BudgetGuidanceState.BUDGET_EXCEEDED)
    return pt
      ? `O orçamento de ${status.budgetAmount} ${currency} para ${scope} já foi ultrapassado em ${status.overage} ${currency}. O limite disponível para novos gastos é 0.00 ${currency}; reduzir gastos futuros não desfaz o valor já gasto.`
      : `The ${status.budgetAmount} ${currency} budget for ${scope} has already been exceeded by ${status.overage} ${currency}. There is 0.00 ${currency} available for further spending; reducing future spending cannot undo previous spending.`;
  if (status.paceGuidanceState === BudgetGuidanceState.NO_DAYS_REMAINING)
    return pt
      ? `Hoje é o último dia do orçamento para ${scope}. Restam ${status.remaining} ${currency}, mas não há dias futuros neste mês para calcular um ritmo diário.`
      : `Today is the last day of the budget for ${scope}. ${status.remaining} ${currency} remains, but there are no future days this month for a daily pace calculation.`;
  if (/por semana|per week|weekly/.test(text(message)))
    return pt
      ? `No orçamento para ${scope}, você ainda pode gastar ${status.remaining} ${currency}. Para manter o limite, pode gastar aproximadamente ${status.allowedSpendingNextWeek} ${currency} nos próximos ${status.nextWeekDays} dias, mantendo ${status.allowedDailyAverageRemaining} ${currency} por dia.`
      : `For the ${scope} budget, ${status.remaining} ${currency} remains. To stay within the limit, allow approximately ${status.allowedSpendingNextWeek} ${currency} over the next ${status.nextWeekDays} days, at ${status.allowedDailyAverageRemaining} ${currency} per day.`;
  const base = pt
    ? `Você ainda pode gastar ${status.remaining} ${currency} no orçamento para ${scope} até o fim do mês. Para permanecer dentro do orçamento de ${status.budgetAmount} ${currency}, seu gasto médio nos ${status.daysRemaining} dias restantes deve ficar em aproximadamente ${status.allowedDailyAverageRemaining} ${currency} por dia.`
    : `You can still spend ${status.remaining} ${currency} within the ${scope} budget this month. To stay within the ${status.budgetAmount} ${currency} budget, average approximately ${status.allowedDailyAverageRemaining} ${currency} per day over the remaining ${status.daysRemaining} days.`;
  return (
    base +
    (status.paceGuidanceState === BudgetGuidanceState.REDUCTION_NEEDED
      ? pt
        ? ` Isso representa uma redução de ${status.requiredDailyReduction} ${currency} por dia, cerca de ${status.requiredReductionPercentage}% em relação ao ritmo atual de ${status.currentDailyAverage} ${currency} por dia.`
        : ` This requires reducing daily spending by ${status.requiredDailyReduction} ${currency}, approximately ${status.requiredReductionPercentage}% from the current ${status.currentDailyAverage} ${currency} daily pace.`
      : pt
        ? ' Não é necessário reduzir seu ritmo atual.'
        : ' No reduction from your current pace is required.')
  );
}
