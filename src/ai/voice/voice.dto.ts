import { IsOptional, IsUUID } from 'class-validator';
export class VoiceDto {
  @IsOptional()
  @IsUUID()
  conversationId?: string;
}
