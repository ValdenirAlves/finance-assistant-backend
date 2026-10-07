import { Controller, Get, Inject, Query, ValidationPipe } from '@nestjs/common';
import { AnalyticsService } from './analytics.service.js';
import { MonthlySummaryDto } from './dto/monthly-summary.dto.js';
import { ByMerchantDto } from './dto/by-merchant.dto.js';

@Controller('analytics')
export class AnalyticsController {
  constructor(
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
  ) {}

  @Get('monthly-summary')
  monthlySummary(
    @Query(
      new ValidationPipe({
        expectedType: MonthlySummaryDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: MonthlySummaryDto,
  ) {
    return this.analytics.monthlySummary(dto);
  }

  @Get('by-merchant')
  byMerchant(
    @Query(
      new ValidationPipe({
        expectedType: ByMerchantDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: ByMerchantDto,
  ) {
    return this.analytics.byMerchant(dto);
  }
}
