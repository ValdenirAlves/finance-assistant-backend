import { BadRequestException } from '@nestjs/common';

export function normalizePrepareExpenseArguments(
  raw: string,
  message: string,
  now = new Date(),
): Record<string, unknown> {
  // Capture JSON number lexemes as strings BEFORE JSON.parse can lose precision.
  // The alternative consumes whole string literals, including escaped quotes,
  // so numbers embedded in merchant/description text are never rewritten.
  const losslessAmount = raw.replace(
    /("(?:\\.|[^"\\])*"\s*:\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s*[,}])|"(?:\\.|[^"\\])*"/g,
    (match: string, prefix: string | undefined, number: string | undefined) => {
      if (!prefix || number === undefined) return match;
      const key = JSON.parse(
        prefix.slice(0, prefix.lastIndexOf(':')).trim(),
      ) as unknown;
      return key === 'amount' ? `${prefix}${JSON.stringify(number)}` : match;
    },
  );
  const parsed: unknown = JSON.parse(losslessAmount);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new BadRequestException('Invalid expense preparation arguments');
  const args = { ...parsed } as Record<string, unknown>;
  if (typeof args.amount === 'string') {
    const amount = args.amount.trim().replace(',', '.');
    const match = /^(0|[1-9]\d{0,14})(?:\.(\d{1,2}))?$/.exec(amount);
    args.amount = match
      ? `${match[1]}.${(match[2] ?? '').padEnd(2, '0')}`
      : amount;
  }
  if (typeof args.currency === 'string')
    args.currency = args.currency.trim().toUpperCase();
  if (typeof args.transactionDate === 'string') {
    const dateText = args.transactionDate.trim();
    const relative = dateText.toLowerCase();
    if (['today', 'hoje', 'yesterday', 'ontem'].includes(relative)) {
      const date = new Date(now);
      if (relative === 'yesterday' || relative === 'ontem')
        date.setUTCDate(date.getUTCDate() - 1);
      args.transactionDate = date.toISOString().slice(0, 10);
    } else args.transactionDate = dateText;
  }
  const aliases: Record<string, string> = {
    english: 'en',
    portuguese: 'pt',
    português: 'pt',
    portugues: 'pt',
  };
  if (typeof args.language === 'string') {
    const language = args.language.trim().toLowerCase();
    args.language =
      aliases[language] ??
      language.replace(
        /-([a-z]{2})$/,
        (_match, region: string) => `-${region.toUpperCase()}`,
      );
  } else if (args.language == null) {
    args.language =
      /\b(registra|registre|gastei|paguei|reais|hoje|ontem)\b/i.test(message)
        ? 'pt'
        : 'en';
  }
  // Backend templates own confirmation for these languages. Unused model prose
  // cannot invalidate otherwise valid expense data or inject financial claims.
  if (
    typeof args.language === 'string' &&
    ['en', 'pt'].includes(args.language.split('-')[0])
  )
    args.confirmationQuestion = null;
  return args;
}
