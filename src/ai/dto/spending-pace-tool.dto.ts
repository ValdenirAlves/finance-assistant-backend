import { IsEnum, IsOptional, IsString } from 'class-validator';
import { Currency, ExpenseCategory } from '../../generated/prisma/enums.js';
import { MonthlyToolDto } from './monthly-tool.dto.js';
export class SpendingPaceToolDto extends MonthlyToolDto {
  @IsOptional() @IsEnum(ExpenseCategory) category?: ExpenseCategory;
  @IsOptional()
  @IsEnum(Currency)
  currency?: Currency;
  @IsOptional()
  @IsString()
  merchant?: string;
}
