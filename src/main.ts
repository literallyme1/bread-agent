import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filter/global-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // class-validator 기반 전역 유효성 검사
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,         // DTO에 정의되지 않은 필드 제거
      forbidNonWhitelisted: true,
      transform: true,         // 타입 자동 변환 (string → number 등)
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // 전역 예외 필터
  app.useGlobalFilters(new GlobalExceptionFilter());

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Server running on port ${port}`);
}

bootstrap();
