import { CategoriesService } from './categories.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ExpenseCategory } from '../generated/prisma/enums.js';
import { pendingDatabase } from '../../test/helpers/pending-database.js';
import { ExpensesService } from '../expenses/expenses.service.js';
import { PendingExpenseService } from '../pending-expenses/pending-expense.service.js';
describe('persisted merchant classifications', () => {
  let store: ReturnType<typeof pendingDatabase>;
  let categories: CategoriesService;
  let expenses: ExpensesService;
  let pending: PendingExpenseService;
  beforeEach(() => {
    store = pendingDatabase();
    const prisma = store.database as unknown as PrismaService;
    categories = new CategoriesService(prisma);
    expenses = new ExpensesService(prisma, categories);
    pending = new PendingExpenseService(prisma, expenses);
  });
  const input = {
    payer: 'SPOUSE' as const,
    amount: '43.00',
    currency: 'EUR' as const,
    transactionDate: '2026-10-13',
    merchant: 'SuperValu',
    category: ExpenseCategory.GROCERIES,
  };
  it.each(['Tesco', ' Lidl ', 'ALDI'])(
    'resolves known mapping %s',
    async (merchant) => {
      expect(await categories.lookup(merchant)).toBe('GROCERIES');
    },
  );
  it('learns only after confirmation and preserves the category', async () => {
    const row = await pending.prepare('conversation', input, null);
    expect(row.category).toBe('GROCERIES');
    expect(store.mappings.has('supervalu')).toBe(false);
    await pending.requestConfirmation('conversation', 1);
    const saved = await pending.confirm('conversation', 1);
    expect(saved?.category).toBe('GROCERIES');
    expect(await categories.lookup(' SuperValu ')).toBe('GROCERIES');
  });
  it('never overwrites mapping with conflicting suggested category', async () => {
    await categories.learn(
      'Tesco',
      ExpenseCategory.PETS,
      store.database as never,
    );
    expect(await categories.lookup('Tesco')).toBe('GROCERIES');
    const row = await pending.prepare(
      'conversation',
      { ...input, merchant: 'Tesco', category: ExpenseCategory.PETS },
      null,
    );
    expect(row.category).toBe('GROCERIES');
  });
  it('cancellation persists neither expense nor learned mapping', async () => {
    await pending.prepare('conversation', input, null);
    await pending.cancel('conversation', 1);
    expect(store.expenses.size).toBe(0);
    expect(store.mappings.has('supervalu')).toBe(false);
  });
  it('rejects arbitrary categories and defaults unknown manual expense to OTHER', async () => {
    await expect(
      expenses.create({ ...input, category: 'MADE_UP' as never }),
    ).rejects.toThrow();
    const row = await expenses.create({ ...input, category: undefined });
    expect(row.category).toBe('OTHER');
  });
});
