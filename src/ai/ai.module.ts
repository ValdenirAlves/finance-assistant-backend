import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module.js';
import { ExpensesModule } from '../expenses/expenses.module.js';
import { AiController } from './ai.controller.js';
import { AiService } from './ai.service.js';
import { ConversationsModule } from '../conversations/conversations.module.js';

@Module({
  imports: [AnalyticsModule, ExpensesModule, ConversationsModule],
  controllers: [AiController],
  providers: [AiService],
})
export class AiModule {}
