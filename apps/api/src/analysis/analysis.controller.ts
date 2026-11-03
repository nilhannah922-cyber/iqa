import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ExecutionService } from '../execution/execution.service';
import { ConfirmResultDto } from '../results/results.dto';
import { ResultsService } from '../results/results.service';
import { EditProposalsService } from '../test-cases/edit-proposals.service';
import {
  CreateEditProposalDto,
  UpdateTestStepDto,
} from '../test-cases/test-cases.dto';
import { TestCasesService } from '../test-cases/test-cases.service';

function caseNumber(value: string): string {
  if (!/^TC-\d+$/.test(value)) {
    throw new BadRequestException(
      `Invalid test case number "${value}" (expected e.g. TC-0001).`,
    );
  }
  return value;
}
import { AnalysisService } from './analysis.service';
import {
  CreateAnalysisDto,
  CreateChecklistItemDto,
  UpdateChecklistItemDto,
} from './analysis.dto';

@Controller('analysis')
export class AnalysisController {
  constructor(
    private readonly analysis: AnalysisService,
    private readonly testCases: TestCasesService,
    private readonly editProposals: EditProposalsService,
    private readonly execution: ExecutionService,
    private readonly results: ResultsService,
  ) {}

  /** Analyzes the page and generates its checklist (takes ~20-40s). */
  @Post()
  create(@Body() dto: CreateAnalysisDto) {
    return this.analysis.create(dto.url);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.analysis.findOne(id);
  }

  @Patch(':id/items/:itemId')
  updateItem(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateChecklistItemDto,
  ) {
    return this.analysis.updateItem(id, itemId, dto);
  }

  @Post(':id/items')
  addItem(@Param('id') id: string, @Body() dto: CreateChecklistItemDto) {
    return this.analysis.addItem(id, dto);
  }

  /** Generates test cases from the approved items (takes ~30-90s). */
  @Post(':id/test-cases')
  generateTestCases(@Param('id') id: string) {
    return this.testCases.generateForRun(id);
  }

  @Get(':id/test-cases')
  listTestCases(@Param('id') id: string) {
    return this.testCases.listForRun(id);
  }

  /** Queues execution of the approved test case sheet (no Claude calls). */
  @Post(':id/execution')
  startExecution(@Param('id') id: string) {
    return this.execution.start(id);
  }

  @Get(':id/execution')
  executionStatus(@Param('id') id: string) {
    return this.execution.status(id);
  }

  /** Deletes results and screenshots; the sheet becomes editable again. */
  @Post(':id/execution/discard')
  discardExecution(@Param('id') id: string) {
    return this.execution.discard(id);
  }

  /** Claude proposes pass/fail per executed case (batches of 5). */
  @Post(':id/results/review')
  reviewResults(@Param('id') id: string) {
    return this.results.review(id);
  }

  @Get(':id/results')
  listResults(@Param('id') id: string) {
    return this.results.list(id);
  }

  @Post(':id/results/confirm-all-as-proposed')
  confirmAllResults(@Param('id') id: string) {
    return this.results.confirmAllAsProposed(id);
  }

  @Patch(':id/results/:caseNumber')
  confirmResult(
    @Param('id') id: string,
    @Param('caseNumber') number: string,
    @Body() dto: ConfirmResultDto,
  ) {
    return this.results.confirm(id, caseNumber(number), dto);
  }

  /** The screenshot of one executed test case (PNG). */
  @Get(':id/screenshots/:caseNumber')
  caseScreenshot(@Param('id') id: string, @Param('caseNumber') number: string) {
    return this.execution.screenshot(id, caseNumber(number));
  }

  /** Asks Claude for a diff for one plain-words instruction (~10-30s). */
  @Post(':id/test-cases/edit-proposals')
  proposeEdit(@Param('id') id: string, @Body() dto: CreateEditProposalDto) {
    return this.editProposals.propose(id, dto.instruction);
  }

  @Get(':id/test-cases/edit-proposals')
  listEditProposals(@Param('id') id: string) {
    return this.editProposals.list(id);
  }

  @Post(':id/test-cases/edit-proposals/:proposalId/apply')
  applyEdit(@Param('id') id: string, @Param('proposalId') proposalId: string) {
    return this.editProposals.apply(id, proposalId);
  }

  @Post(':id/test-cases/edit-proposals/:proposalId/discard')
  discardEdit(
    @Param('id') id: string,
    @Param('proposalId') proposalId: string,
  ) {
    return this.editProposals.discard(id, proposalId);
  }

  /** Marks the run's test case sheet as approved for execution. */
  @Post(':id/test-cases/approve')
  approveTestCases(@Param('id') id: string) {
    return this.testCases.approve(id);
  }

  @Patch(':id/test-cases/:caseNumber/steps/:stepNumber')
  updateTestStep(
    @Param('id') id: string,
    @Param('caseNumber') number: string,
    @Param('stepNumber', ParseIntPipe) step: number,
    @Body() dto: UpdateTestStepDto,
  ) {
    return this.testCases.updateStep(id, caseNumber(number), step, dto);
  }

  @Delete(':id/test-cases/:caseNumber/steps/:stepNumber')
  deleteTestStep(
    @Param('id') id: string,
    @Param('caseNumber') number: string,
    @Param('stepNumber', ParseIntPipe) step: number,
  ) {
    return this.testCases.deleteStep(id, caseNumber(number), step);
  }

  @Delete(':id/test-cases/:caseNumber')
  deleteTestCase(@Param('id') id: string, @Param('caseNumber') number: string) {
    return this.testCases.deleteCase(id, caseNumber(number));
  }
}
