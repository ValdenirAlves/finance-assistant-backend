import { Module } from '@nestjs/common';
import { AiService } from './ai.service.js';
import { OpenAIConfig } from './openai.config.js';
import { AnalyticsModule } from '../analytics/analytics.module.js';
import { InsightsModule } from '../analytics/insights/insights.module.js';
import { ExpensesModule } from '../expenses/expenses.module.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { PendingExpensesModule } from '../pending-expenses/pending-expenses.module.js';
import { BudgetsModule } from '../budgets/budgets.module.js';
import { BankAccountsModule } from '../bank-accounts/bank-accounts.module.js';

// Shared provider registration only. Chat, legacy, Realtime and Live use one agent.
@Module({
  imports: [
    AnalyticsModule,
    InsightsModule,
    ExpensesModule,
    ConversationsModule,
    PendingExpensesModule,
    BudgetsModule,
    BankAccountsModule,
  ],
  providers: [AiService, OpenAIConfig],
  exports: [AiService, OpenAIConfig, ConversationsModule],
})
export class FinanceAgentModule {}
