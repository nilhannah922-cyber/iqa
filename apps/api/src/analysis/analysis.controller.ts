import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { AnalysisService } from './analysis.service';
import {
  CreateAnalysisDto,
  CreateChecklistItemDto,
  UpdateChecklistItemDto,
} from './analysis.dto';

@Controller('analysis')
export class AnalysisController {
  constructor(private readonly analysis: AnalysisService) {}

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
}
