import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnv } from './checklist/checklist.service';

const DEFAULT_PORT = 4000;
const WEB_ORIGIN = 'http://localhost:3000';

async function bootstrap() {
  loadEnv();
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: WEB_ORIGIN });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
  );
  await app.listen(Number(process.env.PORT) || DEFAULT_PORT);
}
void bootstrap();
