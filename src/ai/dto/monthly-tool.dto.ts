import { IsInt, Max, Min } from 'class-validator';

export class MonthlyToolDto {
  @IsInt()
  @Min(1)
  @Max(9999)
  year!: number;

  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;
}
