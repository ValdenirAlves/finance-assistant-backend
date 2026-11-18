import { ExpensePayer } from '../generated/prisma/enums.js';

export function mentionsBankBalance(text: string) {
  return /\b(saldo|balance|bank account|conta banc[aá]ria|private bank|(?:na|minha|sua) conta|your (?:bank )?account|available funds|fundos dispon[ií]veis)\b/i.test(
    text,
  );
}
export function balanceReadRequested(text: string) {
  if (/\b(esposa|esposo|wife|husband|spouse)\b/i.test(text)) return false;
  if (
    /\b(n[aã]o|not|don't|never|sem|without)\b.{0,60}\b(saldo|balance|conta|account|funds)\b/i.test(
      text,
    )
  )
    return false;
  if (/\b(antes|previous|earlier|last turn|perguntei)\b/i.test(text))
    return false;
  if (
    /\b(or[cç]amento|budget)\b/i.test(text) &&
    !/\b(banc|bank|conta|account)\b/i.test(text)
  )
    return false;
  return (
    /\b(?:quanto (?:eu )?tenho|how much (?:money )?(?:do i have|is)).{0,35}\b(?:na conta|in my (?:bank )?account)\b/i.test(
      text,
    ) ||
    /\b(qual|quanto|consulte|consultar|mostr[ae]|diga|ver|veja|what|how|show|tell|check)\b.{0,60}\b(saldo|(?:bank |account )?balance)\b/i.test(
      text,
    ) ||
    /^(?:e |and )?(?:meu saldo|my balance)\s*\?$/i.test(text.trim())
  );
}
export function balanceWriteRequested(text: string) {
  return (
    !balanceReadRequested(text) &&
    !text.includes('?') &&
    !/\b(n[aã]o|not|don't|never|earlier|previous|perguntei)\b/i.test(text) &&
    /\d/.test(text) &&
    (/^(?:por favor[,:]?\s+|please\s+)?(?:meu saldo\b|my (?:bank |account )?balance\b|(?:atualiz[ae]|defin[ae]|registre|registra|set|update|record)\b.*\b(?:saldo|balance)\b)/i.test(
      text.trim(),
    ) ||
      /^(?:eu\s+)?tenho\b.*\bconta\b/i.test(text.trim()) ||
      /^i have\b.*\baccount\b/i.test(text.trim()))
  );
}
export function payerFromMessage(text: string): ExpensePayer | null {
  if (/\b(n[aã]o|not|neither)\b/i.test(text)) return null;
  const spouse = /\b(esposa|esposo|wife|husband|spouse)\b/i.test(text);
  const self =
    /\b(meu cart[aã]o|minha conta|meus? recursos|my (?:own )?(?:card|account)|own card)\b/i.test(
      text,
    );
  if (spouse === self) return null;
  return spouse ? ExpensePayer.SPOUSE : ExpensePayer.SELF;
}
export function payerQuestion(pt: boolean) {
  return pt
    ? 'Foi no seu cartão ou no cartão da sua esposa?'
    : 'Was this paid with your own card/account or your spouse’s card?';
}
export function privateBalanceNotice(pt: boolean) {
  return pt
    ? 'Consulte o saldo explicitamente para receber informações da sua conta.'
    : 'Please explicitly ask about your bank balance to retrieve that private information.';
}
