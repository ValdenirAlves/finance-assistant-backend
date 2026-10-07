import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ExpensesModule } from './expenses/expenses.module.js';
import { CategoriesModule } from './categories/categories.module.js';
import { BudgetsModule } from './budgets/budgets.module.js';
import { AnalyticsModule } from './analytics/analytics.module.js';

@Module({
  imports: [ExpensesModule, CategoriesModule, BudgetsModule, AnalyticsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
