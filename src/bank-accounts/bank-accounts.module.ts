import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { BankAccountsService } from './bank-accounts.service.js';
import { BankAccountsController } from './bank-accounts.controller.js';
@Module({
  imports: [PrismaModule],
  providers: [BankAccountsService],
  controllers: [BankAccountsController],
  exports: [BankAccountsService],
})
export class BankAccountsModule {}
