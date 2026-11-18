import { Module } from '@nestjs/common';
import { BankAccountsModule } from './bank-accounts/bank-accounts.module.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ExpensesModule } from './expenses/expenses.module.js';
import { CategoriesModule } from './categories/categories.module.js';
import { BudgetsModule } from './budgets/budgets.module.js';
import { AnalyticsModule } from './analytics/analytics.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AiModule } from './ai/ai.module.js';
import { PocModule } from './ai/live-responses-poc/poc.module.js';

@Module({
  imports: [
    PocModule,
    BankAccountsModule,
    AiModule,
    PrismaModule,
    ExpensesModule,
    CategoriesModule,
    BudgetsModule,
    AnalyticsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
