import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filter/global-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'error', 'warn', 'debug', 'verbose'],
  });

  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new GlobalExceptionFilter());

  app.enableCors({
    origin: ['http://localhost:3000'],
    credentials: true,
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Bread API')
    .setDescription('Bread Reservation & Inventory API')
    .setVersion('1.0')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('swagger', app, document);

  // Write the Swagger spec to disk so AiService can load it as Gemini tools
  // on the next (or current, second-boot) server start.
  try {
    writeFileSync(join(process.cwd(), 'swagger-spec.json'), JSON.stringify(document, null, 2));
  } catch (err) {
    console.warn('Failed to write swagger-spec.json:', err);
  }

  const port = process.env.PORT ?? 8080;
  await app.listen(port);
  console.log(`Server running on port ${port}`);
  console.log(`Swagger UI: http://localhost:${port}/swagger`);
}

bootstrap();
