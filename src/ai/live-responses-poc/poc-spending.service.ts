import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { FunctionTool } from 'openai/resources/live/live';
import { AnalyticsService } from '../../analytics/analytics.service.js';
import { SpendingPaceToolDto } from '../dto/spending-pace-tool.dto.js';
import { Currency, ExpenseCategory } from '../../generated/prisma/enums.js';

export const spendingTool: FunctionTool = {
  type: 'function',
  name: 'get_spending',
  strict: true,
  description:
    'READ ONLY. Get backend-calculated monthly spending, optionally filtered by category, merchant or original currency. Current month is month-to-date (UTC); past months are complete. No balances, account details or writes.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['year', 'month', 'merchant', 'category', 'currency'],
    properties: {
      year: { type: 'integer', minimum: 1, maximum: 9999 },
      month: { type: 'integer', minimum: 1, maximum: 12 },
      merchant: { type: ['string', 'null'] },
      category: {
        type: ['string', 'null'],
        enum: [...Object.values(ExpenseCategory), null],
      },
      currency: {
        type: ['string', 'null'],
        enum: [...Object.values(Currency), null],
      },
    },
  },
};

@Injectable()
export class PocSpendingService {
  constructor(
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
  ) {}
  validate(name: string, args: string) {
    if (name !== spendingTool.name)
      throw new BadRequestException('Unsupported POC tool');
    if (args.length > 4096)
      throw new BadRequestException('POC arguments too large');
    let raw: unknown;
    try {
      raw = JSON.parse(args);
    } catch {
      throw new BadRequestException('Invalid POC arguments');
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new BadRequestException('Invalid POC arguments');
    const dto = plainToInstance(SpendingPaceToolDto, raw);
    if (
      validateSync(dto, { whitelist: true, forbidNonWhitelisted: true })
        .length ||
      (dto.merchant != null &&
        (!dto.merchant.trim() || dto.merchant.length > 200))
    )
      throw new BadRequestException('Invalid POC arguments');
    return dto;
  }
  async read(dto: SpendingPaceToolDto) {
    const data = await this.analytics.spendingPace({
      year: String(dto.year).padStart(4, '0'),
      month: String(dto.month),
      merchant: dto.merchant,
      category: dto.category,
      currency: dto.currency,
    });
    // Project existing domain totals only; no financial arithmetic or projections in the AI layer.
    return {
      period: data.period,
      filters: {
        merchant: dto.merchant ?? null,
        category: dto.category ?? null,
        currency: dto.currency ?? null,
      },
      totals: Object.fromEntries(
        data.results.map((row) => [row.currency, row.spentToDate]),
      ),
    };
  }
}
