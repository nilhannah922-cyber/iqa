import { Module } from '@nestjs/common';
import { ExecutionService } from '../execution/execution.service';
import { EditProposalsService } from '../test-cases/edit-proposals.service';
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
    EditProposalsService,
    ExecutionService,
    { provide: STORAGE, useFactory: () => new LocalDiskStorage() },
  ],
})
export class AnalysisModule {}
