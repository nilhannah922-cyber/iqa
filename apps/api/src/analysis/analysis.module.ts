import { Module } from '@nestjs/common';
import { TestCasesService } from '../test-cases/test-cases.service';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { LocalDiskStorage } from './storage';
import { STORAGE } from './storage.token';

@Module({
  controllers: [AnalysisController],
  providers: [
    AnalysisService,
    TestCasesService,
    { provide: STORAGE, useFactory: () => new LocalDiskStorage() },
  ],
})
export class AnalysisModule {}
