import { categoryLabels } from '../categories/categories.service.js';
import { ExpenseCategory } from '../generated/prisma/enums.js';

const normalized = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
const aliases: Partial<Record<ExpenseCategory, string[]>> = {
  GROCERIES: [
    'mercado',
    'mercados',
    'supermercados',
    'supermarket',
    'supermarkets',
  ],
  PETS: ['pet', 'pet shop', 'animais'],
  OTHER: [
    'outras despesas',
    'outros gastos',
    'outros',
    'other expenses',
    'other spending',
  ],
};
function categoriesIn(value: string) {
  return Object.values(ExpenseCategory).filter((category) =>
    [...categoryLabels[category], ...(aliases[category] ?? [])].some((label) =>
      new RegExp(`\\b${normalized(label)}\\b`).test(value),
    ),
  );
}
export type SpendingQuery = {
  range?: { from: string; to: string };
  category?: ExpenseCategory;
  excludeCategories?: ExpenseCategory[];
  tool: 'get_by_category' | 'get_expenses';
};

// Deliberately limited to direct spending reads, not writes, pace or budget intents.
// Unrecognized phrasing remains with the existing model orchestration.
export function resolveSpendingQuery(
  message: string,
  now: Date,
): SpendingQuery | undefined {
  const value = normalized(message);
  if (
    !/\b(?:quanto (?:eu )?(?:gastei|gasto)|how much (?:did i spend|have i spent|do i spend)|what did i spend)\b/.test(
      value,
    ) ||
    /\b(?:orcamento|budget|saldo|balance|media|average|projecao|project|projected|recorrente|recurring|por semana|por dia|per week|per day)\b/.test(
      value,
    )
  )
    return;
  const exclusion =
    /\b(?:alem de|exceto|excluindo|excluding|except|other than|besides)\b/.exec(
      value,
    );
  const excluded = exclusion
    ? categoriesIn(value.slice(exclusion.index + exclusion[0].length))
    : [];
  // A category word inside a merchant name (e.g. Mercado Livre / Pets at Home)
  // must not turn a merchant query into a category-only query.
  const included =
    exclusion || /\b(?:no|na|at)\b/.test(value) ? [] : categoriesIn(value);
  const category = included.length === 1 ? included[0] : undefined;
  // A named or relative period, a date/number, or an unbounded interval must
  // never be silently replaced with this month's range.
  const explicitPeriod =
    /\d|\b(?:hoje|ontem|anteontem|today|yesterday|tomorrow|amanha|dia|dias|day|days|semana|semanas|week|weeks|mes|meses|month|months|ano|anos|year|years|janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|january|february|march|april|may|june|july|august|september|october|november|december|segunda|terca|quarta|quinta|sexta|sabado|domingo|monday|tuesday|wednesday|thursday|friday|saturday|sunday|desde|since|entre|between|sempre|ever|all time|historico|periodo|period|intervalo|range|ultim[oa]s?|last|recentemente|recently)\b/.test(
      value,
    );
  const to = now.toISOString().slice(0, 10);
  return {
    ...(explicitPeriod ? {} : { range: { from: `${to.slice(0, 7)}-01`, to } }),
    ...(category ? { category } : {}),
    ...(excluded.length ? { excludeCategories: excluded } : {}),
    tool:
      included.length || excluded.length ? 'get_by_category' : 'get_expenses',
  };
}
