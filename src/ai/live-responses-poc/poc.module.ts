import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../../analytics/analytics.module.js';
import { LiveConfig } from '../live/live.config.js';
import { LiveTransport } from '../live/live.transport.js';
import { PocConfig } from './poc.config.js';
import { PocTransport } from './poc.transport.js';
import { PocService } from './poc.service.js';
import { PocController } from './poc.controller.js';
import { PocSpendingService } from './poc-spending.service.js';
@Module({
  imports: [AnalyticsModule],
  controllers: [PocController],
  providers: [
    PocConfig,
    PocTransport,
    PocService,
    PocSpendingService,
    LiveConfig,
    LiveTransport,
  ],
})
export class PocModule {}
