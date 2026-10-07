import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Prisma } from '../generated/prisma/client.js';
import type { Expense } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateExpenseDto } from './dto/create-expense.dto.js';

@Injectable()
export class ExpensesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(input: CreateExpenseDto) {
    const dto = plainToInstance(CreateExpenseDto, input);
    const errors = validateSync(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (errors.length) {
      throw new BadRequestException(
        errors.flatMap((error) => Object.values(error.constraints ?? {})),
      );
    }
    const amount = new Prisma.Decimal(dto.amount);
    if (!amount.gt('0')) {
      throw new BadRequestException('amount must be greater than 0');
    }
    const transactionDate = new Date(dto.transactionDate);
    if (Number.isNaN(transactionDate.getTime())) {
      throw new BadRequestException('transactionDate must be a valid date');
    }
    const expense = await this.prisma.expense.create({
      data: {
        amount,
        currency: dto.currency,
        transactionDate,
        description: dto.description ?? null,
        merchant: dto.merchant ?? null,
      },
    });
    return this.serialize(expense);
  }

  async findAll() {
    const expenses = await this.prisma.expense.findMany({
      orderBy: { transactionDate: 'desc' },
    });
    return expenses.map((expense) => this.serialize(expense));
  }

  async findById(id: string) {
    const expense = await this.prisma.expense.findUnique({ where: { id } });
    if (!expense) throw new NotFoundException('Expense not found');
    return this.serialize(expense);
  }

  private serialize(expense: Expense) {
    return { ...expense, amount: expense.amount.toFixed(4) };
  }
}
