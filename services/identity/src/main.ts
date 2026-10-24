// ALVEARE Identity — service NestJS (squelette E1, PRD E2 à venir).
// Zone Red : tout ajout lié à l'authentification exige une revue
// indépendante (wiki/pages/concepts/revue-criticite.md).

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Controller, Get, Module } from '@nestjs/common';

@Controller()
class AppController {
  @Get('/healthz')
  health() {
    return {
      service: 'alveare-identity',
      status: 'ok',
      version: '0.0.1',
      bricks: ['skeleton'], // E2 ajoutera ici : identity, consent, mfa
    };
  }
}

@Module({
  controllers: [AppController],
})
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(4000, 'localhost');
}
void bootstrap();
