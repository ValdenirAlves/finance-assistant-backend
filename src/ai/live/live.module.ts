import { Module } from '@nestjs/common';
import { LiveController } from './live.controller.js';
import { LiveConfig } from './live.config.js';
import { LiveService } from './live.service.js';
import { LiveTransport } from './live.transport.js';
import { FinanceAgentModule } from '../finance-agent.module.js';
import { LiveFinanceAdapter } from './live-finance.adapter.js';
@Module({
  imports: [FinanceAgentModule],
  controllers: [LiveController],
  providers: [LiveConfig, LiveTransport, LiveService, LiveFinanceAdapter],
})
export class LiveModule {}
