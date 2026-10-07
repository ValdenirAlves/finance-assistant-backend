import { IsEnum, IsISO8601, IsOptional, IsString } from 'class-validator';
import { Currency } from '../../generated/prisma/enums.js';

export class FilterExpensesDto {
  @IsOptional()
  @IsEnum(Currency)
  currency?: Currency;

  @IsOptional()
  @IsString()
  merchant?: string;

  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  to?: string;
}
