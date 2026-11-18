import type { FunctionTool } from 'openai/resources/responses/responses.js';
import { ExpenseCategory } from '../generated/prisma/enums.js';
import {
  InsightSeverity,
  InsightType,
} from '../analytics/insights/insights.dto.js';
const categorySchema = {
  type: ['string', 'null'],
  enum: [...Object.values(ExpenseCategory), null],
};

export const clarificationTool: FunctionTool = {
  type: 'function',
  name: 'ask_clarification',
  strict: true,
  description:
    'Non-financial control: ask the user for genuinely missing or ambiguous information needed to continue safely. Write a natural question in the user language. Never include financial factual claims, amounts, totals or bank balances. Does not retrieve data, prepare a write, authorize disclosure or confirm anything. Does not clear an existing draft. Do not ask for a period when a direct spending query already has a backend default range. Do not use for a clearly resolved pending field: patch it instead, without semantic reconfirmation. For a new expense with resolved amount/currency/date but missing payer, prepare_expense with payer=null persists the draft and asks who paid; do not use this control tool as a substitute.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { question: { type: 'string', minLength: 1, maxLength: 1000 } },
    required: ['question'],
  },
};

export const financeTools: FunctionTool[] = [
  {
    type: 'function',
    name: 'get_bank_balance',
    strict: true,
    description:
      'Private bank balance. Only permitted when the CURRENT user turn explicitly asks about their bank balance; never for spending/budgets/insights.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        currency: { type: ['string', 'null'], enum: ['EUR', 'BRL', null] },
        account: { type: ['string', 'null'] },
      },
      required: ['currency', 'account'],
    },
  },
  {
    type: 'function',
    name: 'prepare_bank_balance_update',
    strict: true,
    description:
      'Prepare an explicitly requested personal bank balance update. Does not update an account; later explicit confirmation is mandatory.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        currentBalance: {
          type: 'string',
          description:
            'Exact signed decimal string, at most two fractional digits',
        },
        currency: { type: 'string', enum: ['EUR', 'BRL'] },
        name: { type: ['string', 'null'] },
      },
      required: ['currentBalance', 'currency', 'name'],
    },
  },
  {
    type: 'function',
    name: 'get_financial_insights',
    strict: true,
    description:
      'Read backend-generated monthly insights with deterministic severity and evidence. Never invent financial alerts. Empty list means no relevant alerts found.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        currency: { type: ['string', 'null'], enum: ['EUR', 'BRL', null] },
        category: categorySchema,
        type: {
          type: ['string', 'null'],
          enum: [...Object.values(InsightType), null],
        },
        severity: {
          type: ['string', 'null'],
          enum: [...Object.values(InsightSeverity), null],
        },
      },
      required: ['currency', 'category', 'type', 'severity'],
    },
  },
  ...(['get_recurring_expenses', 'get_recurring_expense_summary'] as const).map(
    (name) => ({
      type: 'function' as const,
      name,
      strict: true,
      description:
        'Backend-detected monthly recurrence with evidence; never infer recurrence from merchant names. Summary excludes LOW confidence. Null filters mean unrestricted.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          currency: { type: ['string', 'null'], enum: ['EUR', 'BRL', null] },
          category: categorySchema,
          merchant: { type: ['string', 'null'] },
          from: { type: ['string', 'null'] },
          to: { type: ['string', 'null'] },
          confidence: {
            type: ['string', 'null'],
            enum: ['HIGH', 'MEDIUM', 'LOW', null],
          },
        },
        required: [
          'currency',
          'category',
          'merchant',
          'from',
          'to',
          'confidence',
        ],
      },
    }),
  ),
  {
    type: 'function',
    name: 'get_by_category',
    strict: true,
    description:
      'Backend totals grouped by category and currency. For exclusion wording use excludeCategories; OTHER is a category, not the complement of other categories. Never add or subtract financial totals yourself.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        category: categorySchema,
        excludeCategories: {
          type: ['array', 'null'],
          items: { type: 'string', enum: Object.values(ExpenseCategory) },
          description:
            'Categories excluded by the backend before summation; null or empty means none.',
        },
      },
      required: ['from', 'to', 'category', 'excludeCategories'],
    },
  },
  ...(['prepare_budget', 'get_budget_status'] as const).map((name) => ({
    type: 'function' as const,
    name,
    strict: true,
    description:
      name === 'prepare_budget'
        ? 'Prepare a monthly budget draft; NEVER saves a Budget. Exactly one merchant/category; requires later explicit confirmation.'
        : 'Read fresh deterministic budget status, projection, daily/weekly allowance and required pace reduction. History may identify scope only; never compute budget math yourself.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...(name === 'prepare_budget'
          ? {
              amount: {
                type: 'string',
                description:
                  'Positive decimal string, at most two fractional digits',
              },
            }
          : {}),
        year: { type: 'integer', minimum: 1, maximum: 9999 },
        month: { type: 'integer', minimum: 1, maximum: 12 },
        currency: { type: 'string', enum: ['EUR', 'BRL'] },
        merchant: { type: ['string', 'null'] },
        category: categorySchema,
      },
      required: [
        ...(name === 'prepare_budget' ? ['amount'] : []),
        'year',
        'month',
        'currency',
        'merchant',
        'category',
      ],
    },
  })),
  {
    type: 'function',
    name: 'get_spending_pace',
    strict: true,
    description:
      'Read backend-calculated daily/weekly spending averages and monthly projection. Never compute these yourself. Null currency/merchant means no filter.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        year: { type: 'integer', minimum: 1, maximum: 9999 },
        month: { type: 'integer', minimum: 1, maximum: 12 },
        currency: { type: ['string', 'null'], enum: ['EUR', 'BRL', null] },
        merchant: { type: ['string', 'null'] },
        category: categorySchema,
      },
      required: ['year', 'month', 'currency', 'merchant', 'category'],
    },
  },
  {
    type: 'function',
    name: 'prepare_expense',
    strict: true,
    description:
      'Prepare a NEW expense draft with resolved amount, currency and transaction date, including amounts expressed in words. NEVER saves an Expense. Missing payer is allowed: pass payer=null and the backend persists the draft before asking who paid. Never keep a resolved expense only in prose while asking for payer. Use only for an explicit new expense creation request, not spending questions. For corrections or supplied fields of an active draft use patch_pending_expense instead. Backend asks for separate save confirmation once complete.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        payer: {
          type: ['string', 'null'],
          enum: ['SELF', 'SPOUSE', null],
          description:
            'Resolve clear current-turn payment information semantically as SELF/SPOUSE. Null when not supplied or unclear; this does not prevent preparing the pending draft. Never assume SELF.',
        },
        paymentMethod: {
          type: ['string', 'null'],
          enum: ['CARD', 'BANK_ACCOUNT', 'CASH', 'OTHER', null],
          description:
            'Payment method explicitly supplied by the user. Do not infer card merely from payer; unknown is null.',
        },
        category: categorySchema,
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
        'payer',
        'paymentMethod',
        'category',
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
    name: 'patch_pending_expense',
    strict: true,
    description:
      'Update only explicitly supplied or corrected fields of the active pending expense, in ANY order, regardless of the last question. A clear semantic answer identifying SELF or SPOUSE must patch payer immediately, without asking the user to reconfirm its meaning. Backend reviews the merged draft and asks for separate SAVE confirmation once complete. Never saves an Expense. Omit unchanged fields from changes. A null value explicitly clears only merchant, description or payer. Merchant is free-form text, not a known-merchant identifier. Never guess payer. Never confirms or cancels.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        changes: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              field: {
                type: 'string',
                enum: [
                  'amount',
                  'currency',
                  'merchant',
                  'description',
                  'transactionDate',
                  'category',
                  'payer',
                  'paymentMethod',
                ],
              },
              value: {
                type: ['string', 'null'],
                description: `Explicit replacement only. Amount: decimal string, at most two fractional digits. Currency: EUR/BRL. Date: ISO UTC or today/yesterday/hoje/ontem. Category: ${Object.values(ExpenseCategory).join(', ')}. Payer: SELF/SPOUSE only if explicitly supplied, otherwise omit the change. PaymentMethod: CARD/BANK_ACCOUNT/CASH/OTHER, independent of payer. Null clears only an explicitly removed optional field.`,
              },
            },
            required: ['field', 'value'],
          },
        },
        language: {
          type: ['string', 'null'],
          description:
            'Response language code, following the current user language/preference.',
        },
        confirmationQuestion: {
          type: ['string', 'null'],
          maxLength: 400,
          pattern: '^[^0-9€$]+$',
          description:
            'Null for en/pt; backend owns the question. Other languages require a localized question asking only for unresolved payer or, when complete, a separate save confirmation. No financial facts or amounts.',
        },
      },
      required: ['changes', 'language', 'confirmationQuestion'],
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
        category: categorySchema,
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
      required: ['currency', 'merchant', 'from', 'to', 'category'],
      additionalProperties: false,
    },
  },
];
