import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { CategoriesService } from './categories.service.js';
@Module({
  imports: [PrismaModule],
  providers: [CategoriesService],
  exports: [CategoriesService],
})
export class CategoriesModule {}
