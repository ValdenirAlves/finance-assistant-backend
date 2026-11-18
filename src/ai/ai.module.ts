import { RealtimeConfig } from './openai.config.js';
import { FinanceAgentModule } from './finance-agent.module.js';
import { RealtimeController } from './realtime/realtime.controller.js';
import { RealtimeService } from './realtime/realtime.service.js';
import { RealtimeTransport } from './realtime/realtime.transport.js';
import { RealtimeToolAdapter } from './realtime/realtime-tool.adapter.js';
import { RealtimeTurnFilterService } from './realtime/realtime-turn-filter.service.js';
import { Module } from '@nestjs/common';
import { LiveModule } from './live/live.module.js';
import { BankAccountsModule } from '../bank-accounts/bank-accounts.module.js';
import { AnalyticsModule } from '../analytics/analytics.module.js';
import { ExpensesModule } from '../expenses/expenses.module.js';
import { AiController } from './ai.controller.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { PendingExpensesModule } from '../pending-expenses/pending-expenses.module.js';
import { VoiceController } from './voice/voice.controller.js';
import { VoiceService } from './voice/voice.service.js';
import { AudioService } from './voice/audio.service.js';
import { BudgetsModule } from '../budgets/budgets.module.js';
import { InsightsModule } from '../analytics/insights/insights.module.js';

@Module({
  imports: [
    FinanceAgentModule,
    LiveModule,
    BankAccountsModule,
    InsightsModule,
    BudgetsModule,
    AnalyticsModule,
    ExpensesModule,
    ConversationsModule,
    PendingExpensesModule,
  ],
  controllers: [AiController, VoiceController, RealtimeController],
  providers: [
    RealtimeConfig,
    RealtimeService,
    RealtimeTransport,
    RealtimeToolAdapter,
    RealtimeTurnFilterService,
    VoiceService,
    AudioService,
  ],
})
export class AiModule {}
