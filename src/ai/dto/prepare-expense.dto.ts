import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { CreateExpenseDto } from '../../expenses/dto/create-expense.dto.js';

export class PrepareExpenseDto extends CreateExpenseDto {
  @IsString()
  @Matches(/^[a-z]{2,3}(?:-[A-Z]{2})?$/)
  language!: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  @Matches(/^[^\d€$]+$/, {
    message:
      'confirmationQuestion must be a non-financial question without amounts',
  })
  confirmationQuestion?: string | null;
}
