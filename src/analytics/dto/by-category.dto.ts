import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsOptional,
} from 'class-validator';
import { ExpenseCategory } from '../../generated/prisma/enums.js';
import { ByMerchantDto } from './by-merchant.dto.js';
export class ByCategoryDto extends ByMerchantDto {
  @IsOptional() @IsEnum(ExpenseCategory) category?: ExpenseCategory;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(Object.values(ExpenseCategory).length)
  @ArrayUnique()
  @IsEnum(ExpenseCategory, { each: true })
  excludeCategories?: ExpenseCategory[];
}
