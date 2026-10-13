import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const NOT_BLANK = /\S/;

export class CreateAnalysisDto {
  @IsString()
  @Matches(NOT_BLANK, { message: 'url should not be blank' })
  @MaxLength(2048)
  url!: string;
}

export class UpdateChecklistItemDto {
  @IsOptional()
  @IsBoolean()
  approved?: boolean;

  @IsOptional()
  @IsBoolean()
  rejected?: boolean;
}

export class CreateChecklistItemDto {
  @IsString()
  @Matches(NOT_BLANK, { message: 'title should not be blank' })
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Matches(NOT_BLANK, {
    each: true,
    message: 'related_selectors should not contain blank values',
  })
  @MaxLength(500, { each: true })
  related_selectors?: string[];
}
