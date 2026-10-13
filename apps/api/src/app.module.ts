import { Module } from '@nestjs/common';
import { AnalysisModule } from './analysis/analysis.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [PrismaModule, AnalysisModule],
})
export class AppModule {}
