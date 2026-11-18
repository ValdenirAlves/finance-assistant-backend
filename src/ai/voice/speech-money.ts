type Language = 'pt' | 'en';

export function languageOf(text: string): Language | undefined {
  const normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (
    /\b(salvo|orcamento|despesa|despesas|voce|gastou|gastei|paguei|sim|salvar|pendente|reais|totalizou)\b/.test(
      normalized,
    )
  )
    return 'pt';
  if (
    /\b(saved|budget|expense|expenses|you|spent|paid|yes|save|pending|total|and)\b/.test(
      normalized,
    )
  )
    return 'en';
  return undefined;
}

export function speechMoney(answer: string, transcript: string): string {
  const language = languageOf(answer) ?? languageOf(transcript);
  if (!language) return answer;
  // Strict monetary tokens only. No grouped/ambiguous decimals, dates or ID substrings.
  // Extra fractional zeros may be removed, but nonzero sub-cent values are untouched.
  const amount = '(?:0|[1-9]\\d*)(?:[.,]\\d{2}(?:0{1,2})?)?';
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_.,/:-])(?:(${amount})\\s+(EUR|BRL)|(EUR|BRL)\\s+(${amount}))(?![\\p{L}\\p{N}_/:-]|[.,]\\d)`,
    'gu',
  );
  return answer.replace(
    pattern,
    (
      _match,
      suffixAmount: string | undefined,
      suffixCurrency: string | undefined,
      prefixCurrency: string | undefined,
      prefixAmount: string | undefined,
    ) => {
      const value = suffixAmount ?? prefixAmount!;
      const currency = suffixCurrency ?? prefixCurrency;
      const [integer, fraction = '00'] = value.replace(',', '.').split('.');
      const cents = fraction.slice(0, 2).replace(/^0/, '') || '0';
      const singular = integer === '1';
      const unit =
        currency === 'EUR'
          ? singular
            ? 'euro'
            : 'euros'
          : language === 'pt'
            ? singular
              ? 'real'
              : 'reais'
            : singular
              ? 'Brazilian real'
              : 'Brazilian reais';
      const centUnit =
        language === 'pt'
          ? cents === '1'
            ? 'centavo'
            : 'centavos'
          : cents === '1'
            ? 'cent'
            : 'cents';
      return `${integer} ${unit}${cents === '0' ? '' : ` ${language === 'pt' ? 'e' : 'and'} ${cents} ${centUnit}`}`;
    },
  );
}
