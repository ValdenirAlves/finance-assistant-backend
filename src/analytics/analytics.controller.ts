import { Controller, Get, Inject, Query, ValidationPipe } from '@nestjs/common';
import { AnalyticsService } from './analytics.service.js';
import { MonthlySummaryDto } from './dto/monthly-summary.dto.js';
import { ByMerchantDto } from './dto/by-merchant.dto.js';
import { SpendingPaceDto } from './dto/spending-pace.dto.js';
import { ByCategoryDto } from './dto/by-category.dto.js';
import { RecurringExpensesDto } from './dto/recurring-expenses.dto.js';
import { RecurringExpensesService } from './recurring-expenses.service.js';

@Controller('analytics')
export class AnalyticsController {
  constructor(
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
    @Inject(RecurringExpensesService)
    private readonly recurring: RecurringExpensesService,
  ) {}

  @Get('recurring-expenses')
  recurringExpenses(
    @Query(
      new ValidationPipe({
        expectedType: RecurringExpensesDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: RecurringExpensesDto,
  ) {
    return this.recurring.findAll(dto);
  }
  @Get('recurring-expenses/summary')
  recurringSummary(
    @Query(
      new ValidationPipe({
        expectedType: RecurringExpensesDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: RecurringExpensesDto,
  ) {
    return this.recurring.summary(dto);
  }

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

  @Get('spending-pace')
  spendingPace(
    @Query(
      new ValidationPipe({
        expectedType: SpendingPaceDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: SpendingPaceDto,
  ) {
    return this.analytics.spendingPace(dto);
  }

  @Get('by-category')
  byCategory(
    @Query(
      new ValidationPipe({
        expectedType: ByCategoryDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: ByCategoryDto,
  ) {
    return this.analytics.byCategory(dto);
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
