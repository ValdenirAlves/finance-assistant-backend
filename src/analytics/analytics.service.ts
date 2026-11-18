import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Prisma } from '../generated/prisma/client.js';
import { Currency } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { parseDateRange } from '../common/date-range.js';
import { MonthlySummaryDto } from './dto/monthly-summary.dto.js';
import { ByMerchantDto } from './dto/by-merchant.dto.js';
import { SpendingPaceDto } from './dto/spending-pace.dto.js';
import { merchantFilter } from '../common/merchant-filter.js';
import { ByCategoryDto } from './dto/by-category.dto.js';

// Higher precision prevents the default Decimal precision from rounding large sums.
const Decimal = Prisma.Decimal.clone({ precision: 40 });

@Injectable()
export class AnalyticsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  currentDate() {
    return new Date();
  }

  async byCategory(input: ByCategoryDto) {
    const dto = plainToInstance(ByCategoryDto, input);
    this.validate(dto);
    const { from, to } = parseDateRange(dto.from, dto.to);
    const expenses = await this.prisma.expense.findMany({
      where: {
        transactionDate: { gte: from, lte: to },
        ...(dto.category ? { category: dto.category } : {}),
        ...(dto.excludeCategories?.length
          ? {
              category: {
                ...(dto.category ? { equals: dto.category } : {}),
                notIn: dto.excludeCategories,
              },
            }
          : {}),
      },
      select: { category: true, currency: true, amount: true },
    });
    const groups = new Map<
      string,
      {
        category: (typeof expenses)[number]['category'];
        currency: Currency;
        total: Prisma.Decimal;
      }
    >();
    for (const expense of expenses) {
      const key = `${expense.category}:${expense.currency}`;
      groups.set(key, {
        category: expense.category,
        currency: expense.currency,
        total: (groups.get(key)?.total ?? new Decimal('0')).plus(
          expense.amount,
        ),
      });
    }
    return [...groups.values()]
      .sort((a, b) =>
        `${a.currency}:${a.category}`.localeCompare(
          `${b.currency}:${b.category}`,
        ),
      )
      .map((group) => ({ ...group, total: group.total.toFixed(2) }));
  }

  async spendingPace(input: SpendingPaceDto, effectiveDate?: Date) {
    const dto = plainToInstance(SpendingPaceDto, input);
    this.validate(dto);
    const now = effectiveDate ?? this.currentDate();
    const year = Number(dto.year),
      month = Number(dto.month);
    const from = new Date(0);
    from.setUTCFullYear(year, month - 1, 1);
    const until = new Date(from);
    until.setUTCMonth(until.getUTCMonth() + 1);
    const daysInMonth = new Date(until.getTime() - 1).getUTCDate();
    const today = new Date(now);
    today.setUTCHours(0, 0, 0, 0);
    const status =
      from > today ? 'future' : until <= today ? 'past' : 'current';
    const daysElapsed =
      status === 'future'
        ? 0
        : status === 'past'
          ? daysInMonth
          : today.getUTCDate();
    const end = status === 'current' ? new Date(today) : until;
    if (status === 'current') end.setUTCDate(end.getUTCDate() + 1);
    const totals = { EUR: new Decimal('0'), BRL: new Decimal('0') };
    if (daysElapsed) {
      const expenses = await this.prisma.expense.findMany({
        where: {
          transactionDate: { gte: from, lt: end },
          ...(dto.currency ? { currency: dto.currency } : {}),
          ...(dto.category != null ? { category: dto.category } : {}),
          ...(dto.merchant != null
            ? { merchant: merchantFilter(dto.merchant) }
            : {}),
        },
        select: { amount: true, currency: true },
      });
      for (const expense of expenses)
        totals[expense.currency] = totals[expense.currency].plus(
          expense.amount,
        );
    }
    const currencies = dto.currency
      ? [dto.currency]
      : [Currency.EUR, Currency.BRL];
    return {
      period: {
        year,
        month,
        effectiveDate:
          status === 'future'
            ? null
            : new Date(end.getTime() - 1).toISOString().slice(0, 10),
        daysElapsed,
        daysInMonth,
        status,
      },
      merchant: dto.merchant ?? null,
      results: currencies.map((currency) => {
        const total = totals[currency];
        const daily = daysElapsed ? total.div(String(daysElapsed)) : null;
        return {
          currency,
          spentToDate: total.toFixed(2),
          dailyAverage: daily?.toFixed(2) ?? null,
          weeklyAverage: daily?.mul('7').toFixed(2) ?? null,
          projectedMonthTotal:
            status === 'past'
              ? total.toFixed(2)
              : (daily?.mul(String(daysInMonth)).toFixed(2) ?? null),
        };
      }),
    };
  }

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
