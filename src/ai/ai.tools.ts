import type { FunctionTool } from 'openai/resources/responses/responses.js';

export const financeTools: FunctionTool[] = [
  {
    type: 'function',
    name: 'prepare_expense',
    strict: true,
    description:
      'Prepare or replace the current draft expense. NEVER saves an Expense. Use only for an explicit creation request or correction to a pending draft, not spending questions. Backend asks for separate confirmation.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        amount: {
          type: ['string', 'number'],
          description:
            'Positive amount with up to two fractional digits. Prefer a decimal string such as "45.00". Numeric JSON input is normalized losslessly by the backend.',
        },
        currency: { type: 'string', enum: ['EUR', 'BRL'] },
        merchant: { type: ['string', 'null'] },
        description: { type: ['string', 'null'] },
        transactionDate: {
          type: 'string',
          description:
            'ISO UTC date/timestamp, or today/yesterday (hoje/ontem). Backend resolves relative dates in UTC before validation.',
        },
        language: {
          type: ['string', 'null'],
          description:
            'Language code (en, pt, fr etc), honoring explicit language preference. Null infers en/pt from the current message.',
        },
        confirmationQuestion: {
          type: ['string', 'null'],
          pattern: '^[^0-9€$]+$',
          maxLength: 400,
          description:
            'Return null for en/pt: the backend generates confirmation text and ignores this field. Other languages require only a short save-confirmation question, without amounts, dates or financial claims.',
        },
      },
      required: [
        'amount',
        'currency',
        'merchant',
        'description',
        'transactionDate',
        'language',
        'confirmationQuestion',
      ],
    },
  },
  {
    type: 'function',
    name: 'get_monthly_summary',
    description: 'Read monthly spending totals separated by original currency.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        year: { type: 'integer', minimum: 1, maximum: 9999 },
        month: { type: 'integer', minimum: 1, maximum: 12 },
      },
      required: ['year', 'month'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_expenses',
    description:
      'Read filtered expenses and backend-computed merchant totals. Null filters mean no restriction. Never calculate totals yourself.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        currency: { type: ['string', 'null'], enum: ['EUR', 'BRL', null] },
        merchant: { type: ['string', 'null'] },
        from: {
          type: ['string', 'null'],
          description: 'ISO date or timestamp, inclusive UTC start',
        },
        to: {
          type: ['string', 'null'],
          description:
            'ISO date or timestamp, inclusive; date-only includes full UTC day',
        },
      },
      required: ['currency', 'merchant', 'from', 'to'],
      additionalProperties: false,
    },
  },
];
