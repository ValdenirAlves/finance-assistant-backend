import type { FunctionTool } from 'openai/resources/responses/responses.js';
import { BANK_BALANCE_FIELDS } from '../bank-accounts/bank-balance-intent.dto.js';

export const bankBalanceIntentTool: FunctionTool = {
  type: 'function',
  name: 'bank_balance_intent',
  strict: true,
  description:
    'Interpret the CURRENT complete utterance as setting a personal bank balance, correcting its persisted pending draft, explicitly confirming saving it, cancelling it or no action. BANK_BALANCE is distinct from EXPENSE. Backend validates and owns revisions, confirmation and persistence. Never authorize using old assistant prose.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'changes'],
    properties: {
      action: {
        type: 'string',
        enum: ['CREATE', 'PATCH', 'CONFIRM', 'CANCEL', 'NO_ACTION'],
      },
      changes: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['field', 'value'],
          properties: {
            field: { type: 'string', enum: [...BANK_BALANCE_FIELDS] },
            value: {
              type: ['string', 'null'],
              description:
                'Only details explicitly supplied/corrected now. currentBalance: exact decimal string, at most 2 fractional digits; signed balances are allowed. currency: EUR or BRL, never guessed. name: optional account name; null clears name only. For PATCH omit every unchanged field. CONFIRM/CANCEL/NO_ACTION require empty changes.',
            },
          },
        },
      },
    },
  },
};
