import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Prisma } from '../generated/prisma/client.js';
import { Currency } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { parseDateRange } from '../common/date-range.js';
import { MonthlySummaryDto } from './dto/monthly-summary.dto.js';
import { ByMerchantDto } from './dto/by-merchant.dto.js';

// Higher precision prevents the default Decimal precision from rounding large sums.
const Decimal = Prisma.Decimal.clone({ precision: 40 });

@Injectable()
export class AnalyticsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async monthlySummary(input: MonthlySummaryDto) {
    const dto = plainToInstance(MonthlySummaryDto, input);
    this.validate(dto);
    const year = Number(dto.year);
    const month = Number(dto.month);
    const from = new Date(0);
    from.setUTCFullYear(year, month - 1, 1);
    const until = new Date(from);
    until.setUTCMonth(until.getUTCMonth() + 1);
    const expenses = await this.prisma.expense.findMany({
      where: { transactionDate: { gte: from, lt: until } },
      select: { amount: true, currency: true },
    });
    const totals = { EUR: new Decimal('0'), BRL: new Decimal('0') };
    for (const expense of expenses) {
      totals[expense.currency] = totals[expense.currency].plus(expense.amount);
    }
    return {
      period: { year, month },
      totals: { EUR: totals.EUR.toFixed(2), BRL: totals.BRL.toFixed(2) },
    };
  }

  async byMerchant(input: ByMerchantDto) {
    const dto = plainToInstance(ByMerchantDto, input);
    this.validate(dto);
    const { from, to } = parseDateRange(dto.from, dto.to);
    const expenses = await this.prisma.expense.findMany({
      where: { transactionDate: { gte: from, lte: to } },
      select: { amount: true, currency: true, merchant: true },
    });
    const groups = new Map<
      string,
      { merchant: string | null; currency: Currency; total: Prisma.Decimal }
    >();
    for (const expense of expenses) {
      const key = JSON.stringify([expense.currency, expense.merchant]);
      const previous = groups.get(key);
      groups.set(key, {
        merchant: expense.merchant,
        currency: expense.currency,
        total: (previous?.total ?? new Decimal('0')).plus(expense.amount),
      });
    }
    // Deterministic lexical order; no monetary comparisons across currencies.
    const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    return [...groups.values()]
      .sort(
        (a, b) =>
          compare(a.currency, b.currency) ||
          (a.merchant === b.merchant
            ? 0
            : a.merchant === null
              ? -1
              : b.merchant === null
                ? 1
                : compare(a.merchant, b.merchant)),
      )
      .map((group) => ({ ...group, total: group.total.toFixed(2) }));
  }

  private validate(dto: object) {
    const errors = validateSync(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (errors.length)
      throw new BadRequestException(
        errors.flatMap((error) => Object.values(error.constraints ?? {})),
      );
  }
}
