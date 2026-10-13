import { Module } from '@nestjs/common';
import { AnalysisController } from './analysis.controller';
import { AnalysisService, STORAGE } from './analysis.service';
import { LocalDiskStorage } from './storage';

@Module({
  controllers: [AnalysisController],
  providers: [
    AnalysisService,
    { provide: STORAGE, useFactory: () => new LocalDiskStorage() },
  ],
})
export class AnalysisModule {}
