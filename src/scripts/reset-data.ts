import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

// Reference rows inserted by 20261013010000_expense_categories, not learned data.
const referenceMappingIds = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000006',
];

export function assertDevelopmentEnvironment(nodeEnv: string | undefined) {
  if (nodeEnv !== undefined && nodeEnv !== 'development') {
    throw new Error(
      'db:reset-data is development-only; NODE_ENV must be development or unset.',
    );
  }
}

export async function resetDevelopmentData(
  prisma: PrismaClient,
  nodeEnv = process.env.NODE_ENV,
  log: (message: string) => void = console.log,
) {
  assertDevelopmentEnvironment(nodeEnv);
  log('Clearing development user/runtime data in one transaction.');
  log(
    'Preserving schema, enums, migration history and six reference merchant mappings.',
  );

  const results = await prisma.$transaction(
    async (tx) => {
      // Remove references to Expense, Budget and Conversation before their parents.
      const steps = [
        {
          table: 'PendingExpense',
          clear: () => tx.pendingExpense.deleteMany(),
        },
        { table: 'PendingBudget', clear: () => tx.pendingBudget.deleteMany() },
        {
          table: 'PendingBankBalance',
          clear: () => tx.pendingBankBalance.deleteMany(),
        },
        {
          table: 'ConversationMessage',
          clear: () => tx.conversationMessage.deleteMany(),
        },
        { table: 'Conversation', clear: () => tx.conversation.deleteMany() },
        { table: 'Expense', clear: () => tx.expense.deleteMany() },
        { table: 'Budget', clear: () => tx.budget.deleteMany() },
        { table: 'BankAccount', clear: () => tx.bankAccount.deleteMany() },
        // Migration backup of user budget labels, not reference category definitions.
        {
          table: 'LegacyBudgetCategory',
          clear: () => tx.legacyBudgetCategory.deleteMany(),
        },
        {
          table: 'MerchantCategoryMapping (learned/runtime rows only)',
          clear: () =>
            tx.merchantCategoryMapping.deleteMany({
              where: { id: { notIn: referenceMappingIds } },
            }),
        },
      ];
      const cleared: { table: string; count: number }[] = [];
      for (const step of steps) {
        log(`Clearing ${step.table}...`);
        const { count } = await step.clear();
        cleared.push({ table: step.table, count });
      }
      return cleared;
    },
    { maxWait: 5_000, timeout: 30_000 },
  );

  for (const { table, count } of results)
    log(`${table}: ${count} rows deleted.`);
  log('Development data reset committed successfully.');
  return results;
}

async function main() {
  assertDevelopmentEnvironment(process.env.NODE_ENV);
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL must be configured.');

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
  try {
    await resetDevelopmentData(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(
      'Development data reset failed:',
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  });
}
