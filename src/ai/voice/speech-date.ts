import { languageOf } from './speech-money.js';

function hasExplicitYear(message: string) {
  const months =
    'january|february|march|april|may|june|july|august|september|october|november|december|janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro';
  return (
    /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b/.test(message) ||
    new RegExp(`\\b(?:${months})\\b[^.!?;\\n]{0,24}\\b\\d{4}\\b`, 'i').test(
      message,
    ) ||
    /\b(?:year|ano|in|em|de)\s+\d{4}\b(?!\s*(?:[.,]\d|EUR|BRL|euros?|reais))/.test(
      message.toLowerCase(),
    )
  );
}

export function speechDate(answer: string, transcript: string): string {
  const language = languageOf(answer) ?? languageOf(transcript);
  if (!language) return answer;
  const includeYear = hasExplicitYear(transcript);
  const iso = '\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z)?';
  // Recognize the backend expense review/saved template and explicit transaction-date
  // labels only; arbitrary dates/years elsewhere in prose are left alone.
  const pattern = new RegExp(
    `((?:^(?:Saved|Salvo|Pending expense|Despesa pendente):[^\\n;]*;[^\\n;]*;(?:[^\\n;]*;)?\\s*|\\b(?:transactionDate|transaction date|data da transa[çc][ãa]o)\\s*:\\s*))(${iso})(?![\\w:+-])`,
    'gmi',
  );
  return answer.replace(pattern, (match, prefix: string, dateText: string) => {
    const date = new Date(dateText);
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== dateText.slice(0, 10)
    )
      return match;
    const formatted = new Intl.DateTimeFormat(
      language === 'pt' ? 'pt-BR' : 'en-US',
      {
        timeZone: 'UTC',
        day: 'numeric',
        month: 'long',
        ...(includeYear ? { year: 'numeric' as const } : {}),
      },
    ).format(date);
    return prefix + formatted;
  });
}
