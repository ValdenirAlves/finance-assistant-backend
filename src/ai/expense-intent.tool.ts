import type { FunctionTool } from 'openai/resources/responses/responses.js';
import { EXPENSE_DRAFT_FIELDS } from '../pending-expenses/expense-intent.dto.js';
export const expenseIntentTool: FunctionTool = {
  type: 'function',
  name: 'expense_intent',
  strict: true,
  description:
    'Interpret the CURRENT complete utterance as an expense creation, explicit field correction, save confirmation, duplicate override, cancellation, status query or no action. STATUS only reads whether the persisted draft is pending/saved/cancelled; it never saves. Backend owns pending state, revisions, validation, required fields and saving. Never use past assistant prose as current authorization.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'changes'],
    properties: {
      action: {
        type: 'string',
        enum: [
          'CREATE',
          'PATCH',
          'CONFIRM',
          'DUPLICATE_CONFIRM',
          'CANCEL',
          'NO_ACTION',
          'STATUS',
        ],
      },
      changes: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['field', 'value'],
          properties: {
            field: { type: 'string', enum: [...EXPENSE_DRAFT_FIELDS] },
            value: {
              type: ['string', 'null'],
              description:
                'Only fields explicitly supplied/corrected now. Amount: exact positive decimal string, max 2 fractional digits. Currency EUR/BRL. Date: concrete ISO UTC date, resolve relative wording against UTC reference. Payer SELF/SPOUSE; paymentMethod CARD/BANK_ACCOUNT/CASH/OTHER; category controlled enum. Merchant free-form. Null explicitly clears a field. Omitted fields are preserved.',
            },
          },
        },
      },
    },
  },
};
