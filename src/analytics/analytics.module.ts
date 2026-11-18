import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AnalyticsController } from './analytics.controller.js';
import { AnalyticsService } from './analytics.service.js';
import { ExpensesModule } from '../expenses/expenses.module.js';
import { RecurringExpensesService } from './recurring-expenses.service.js';

@Module({
  imports: [PrismaModule, ExpensesModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, RecurringExpensesService],
  exports: [AnalyticsService, RecurringExpensesService],
})
export class AnalyticsModule {}
