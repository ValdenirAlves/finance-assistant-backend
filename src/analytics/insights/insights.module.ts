import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics.module.js';
import { BudgetsModule } from '../../budgets/budgets.module.js';
import { InsightsController } from './insights.controller.js';
import { InsightsService } from './insights.service.js';
@Module({
  imports: [AnalyticsModule, BudgetsModule],
  controllers: [InsightsController],
  providers: [InsightsService],
  exports: [InsightsService],
})
export class InsightsModule {}
