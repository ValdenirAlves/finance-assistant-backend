// Conservative routing only. The model still extracts every expense field and
// the domain service validates it. This never authorizes final persistence.
export function isExplicitExpensePreparation(message: string): boolean {
  const text = message.trim();
  if (text.includes('?')) return false;
  const declaration =
    /^(?:please\s+)?(?:i\s+(?:spent|paid)\b|(?:yesterday|today)\s+i\s+(?:spent|paid)\b|(?:eu\s+)?(?:gastei|paguei)\b|(?:hoje|ontem)\s+(?:eu\s+)?(?:gastei|paguei)\b|(?:add|record|log|registra|registre|registrar|anota|anote)\b)/i;
  const amountAndCurrency = /\b\d+(?:[.,]\d+)?\s*(?:EUR|BRL|euros?|reais)\b/i;
  return declaration.test(text) && amountAndCurrency.test(text);
}
