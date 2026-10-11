import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ExpensesModule } from '../expenses/expenses.module.js';
import { PendingExpenseService } from './pending-expense.service.js';

@Module({
  imports: [PrismaModule, ExpensesModule],
  providers: [PendingExpenseService],
  exports: [PendingExpenseService],
})
export class PendingExpensesModule {}
