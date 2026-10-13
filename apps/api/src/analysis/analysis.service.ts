import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ChecklistError,
  ChecklistService,
  assertApiKeySet,
} from '../checklist/checklist.service';
import { AnalysisError, analyzePage, parseUrl } from './analyze-page';
import { CreateChecklistItemDto, UpdateChecklistItemDto } from './analysis.dto';
import type { StorageProvider } from './storage';

/** Injection token for the StorageProvider used to save analysis files. */
export const STORAGE = Symbol('STORAGE');

// Items are returned nested under their run, so the foreign key is redundant.
const itemOmit = { test_run_id: true } as const;

const runWithItems = {
  checklist_items: { orderBy: { id: 'asc' }, omit: itemOmit },
} satisfies Prisma.test_runsInclude;

type RunWithItems = Prisma.test_runsGetPayload<{
  include: typeof runWithItems;
}>;

export type ChecklistItemView = RunWithItems['checklist_items'][number];

export type AnalysisRunView = Omit<RunWithItems, 'checklist_items'> & {
  items: ChecklistItemView[];
};

function toView(run: RunWithItems): AnalysisRunView {
  const { checklist_items, ...rest } = run;
  return { ...rest, items: checklist_items };
}

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: StorageProvider,
  ) {}

  async create(rawUrl: string): Promise<AnalysisRunView> {
    let url: string;
    try {
      url = parseUrl(rawUrl.trim()).toString();
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    try {
      assertApiKeySet();
    } catch (err) {
      throw new ServiceUnavailableException((err as Error).message);
    }

    const run = await this.prisma.test_runs.create({
      data: { mode: 'full_check', url, status: 'analyzing' },
    });

    try {
      const { analysis, screenshot, screenshotKey, pageJsonKey } =
        await analyzePage(url, this.storage);
      // Store storage keys, not locations; resolve with this.storage.resolve().
      await this.prisma.test_runs.update({
        where: { id: run.id },
        data: {
          status: 'generating_checklist',
          screenshot_path: screenshotKey,
          page_json_path: pageJsonKey,
        },
      });

      const checklist = await new ChecklistService().generate(
        analysis,
        screenshot,
      );
      for (const warning of checklist.warnings) {
        this.logger.warn(`Run ${run.id}: ${warning}`);
      }
      this.logger.log(
        `Run ${run.id}: ${checklist.items.length} items from ${checklist.model} ` +
          `(input=${checklist.usage.input_tokens}, output=${checklist.usage.output_tokens} tokens)`,
      );

      await this.prisma.$transaction([
        this.prisma.checklist_items.createMany({
          data: checklist.items.map((item) => ({
            test_run_id: run.id,
            title: item.title,
            description: item.description,
            related_selectors: item.related_selectors,
            source: 'scan' as const,
          })),
        }),
        this.prisma.test_runs.update({
          where: { id: run.id },
          data: { status: 'checklist_ready' },
        }),
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.test_runs.update({
        where: { id: run.id },
        data: { status: 'failed', error: message },
      });
      if (err instanceof AnalysisError) {
        throw new UnprocessableEntityException({
          message,
          error: 'Unprocessable Entity',
          statusCode: 422,
          run_id: run.id,
        });
      }
      if (err instanceof ChecklistError) {
        throw new BadGatewayException({
          message,
          error: 'Bad Gateway',
          statusCode: 502,
          run_id: run.id,
        });
      }
      throw err;
    }

    return this.findOne(run.id);
  }

  async findOne(id: string): Promise<AnalysisRunView> {
    const run = await this.prisma.test_runs.findUnique({
      where: { id },
      include: runWithItems,
    });
    if (!run) throw new NotFoundException(`Analysis run ${id} not found.`);
    return toView(run);
  }

  async updateItem(
    runId: string,
    itemId: string,
    dto: UpdateChecklistItemDto,
  ): Promise<ChecklistItemView> {
    if (dto.approved === undefined && dto.rejected === undefined) {
      throw new BadRequestException(
        'Provide "approved" and/or "rejected" (booleans).',
      );
    }
    if (dto.approved && dto.rejected) {
      throw new BadRequestException(
        'An item cannot be both approved and rejected.',
      );
    }
    await this.findItem(runId, itemId);

    // Approving clears a rejection and vice versa, unless both are given.
    const data: Prisma.checklist_itemsUpdateInput = {};
    if (dto.approved !== undefined) data.approved = dto.approved;
    if (dto.rejected !== undefined) data.rejected = dto.rejected;
    if (dto.approved && dto.rejected === undefined) data.rejected = false;
    if (dto.rejected && dto.approved === undefined) data.approved = false;

    return this.prisma.checklist_items.update({
      where: { id: itemId },
      data,
      omit: itemOmit,
    });
  }

  async addItem(
    runId: string,
    dto: CreateChecklistItemDto,
  ): Promise<ChecklistItemView> {
    await this.findRun(runId);
    return this.prisma.checklist_items.create({
      omit: itemOmit,
      data: {
        test_run_id: runId,
        title: dto.title.trim(),
        description: dto.description?.trim() ?? '',
        related_selectors: [...new Set(dto.related_selectors ?? [])],
        added_by_user: true,
        source: 'user_note',
      },
    });
  }

  private async findRun(id: string) {
    const run = await this.prisma.test_runs.findUnique({ where: { id } });
    if (!run) throw new NotFoundException(`Analysis run ${id} not found.`);
    return run;
  }

  private async findItem(runId: string, itemId: string) {
    const item = await this.prisma.checklist_items.findFirst({
      where: { id: itemId, test_run_id: runId },
    });
    if (!item) {
      await this.findRun(runId);
      throw new NotFoundException(
        `Checklist item ${itemId} not found in run ${runId}.`,
      );
    }
    return item;
  }
}
