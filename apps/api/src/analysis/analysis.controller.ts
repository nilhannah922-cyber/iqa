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
import { UpdateTestStepDto } from '../test-cases/test-cases.dto';
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
