import type { FunctionTool } from 'openai/resources/responses/responses.js';

export const financeTools: FunctionTool[] = [
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
