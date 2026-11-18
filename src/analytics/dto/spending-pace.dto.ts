import { IsEnum, IsOptional, IsString } from 'class-validator';
import { Currency, ExpenseCategory } from '../../generated/prisma/enums.js';
import { MonthlySummaryDto } from './monthly-summary.dto.js';
export class SpendingPaceDto extends MonthlySummaryDto {
  @IsOptional() @IsEnum(ExpenseCategory) category?: ExpenseCategory;
  @IsOptional()
  @IsEnum(Currency)
  currency?: Currency;
  @IsOptional()
  @IsString()
  merchant?: string;
}
