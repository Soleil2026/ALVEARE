/**
 * @alveare/documents — service NestJS de gestion documentaire (E4).
 * Zone Red : toute modification fichiers/integrity/partage exige une
 * revue indépendante (auteur ≠ réviseur) + accord humain final.
 *
 * Principes :
 * - Le contenu ne s'obtient QUE par URL temporaire signée (TTL+jti),
 *   révocable par le propriétaire — jamais via URL publique non signée.
 * - Ownership strict : un authentifié ne voit que ses documents.
 * - Audit sync de chaque upload/partage/révocation/téléchargement.
 * - Auth = @alveare/auth (packages/shared point = source de vérité).
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  BadRequestException,
  Body,
  CanActivate,
  Controller,
  Delete,
  ExecutionContext,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, unlink, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as QRCode from 'qrcode';
import type { Express, Request, Response } from 'express';
import { requireToken, type TokenUser } from '@alveare/auth';
import { isSafeStoredPath, sanitizeFileName, validateUpload } from './files';
import { clampTtl, createShareToken, verifyShareToken } from './shares';

type AuthRequest = Request & { user?: TokenUser };

const DATA_DIR = process.env.DOC_DATA_DIR ?? path.resolve('data/documents');
const PUBLIC_BASE = process.env.DOC_PUBLIC_BASE_URL ?? 'http://localhost:4010';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
    mkdirSync(DATA_DIR, { recursive: true });
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}

/** Trace d'audit sync (schéma audit, table events — SQL brut). */
async function audit(
  tx: { $queryRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> },
  actor: string,
  action: string,
  target: string,
) {
  await tx.$queryRaw`
    INSERT INTO audit.events (actor, action, target)
    VALUES (${actor}, ${action}, ${target})`;
}

/** Exige un access token valide. */
@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthRequest>();
    req.user = await requireToken(req);
    return true;
  }
}

function docIdOf(rawId: string): bigint {
  try {
    return BigInt(rawId);
  } catch {
    throw new BadRequestException('id invalide');
  }
}

@Controller()
class DocsController {
  constructor(private prisma: PrismaService) {}

  /** Upload (FR-04.1) : validation + sha256 + disque + BD + audit. */
  @Post('documents')
  @UseGuards(AuthGuard)
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @Req() req: AuthRequest,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const user = req.user as TokenUser;
    if (!file || !file.originalname) throw new BadRequestException('champ "file" manquant');
    const buf = file.buffer;
    validateUpload(file.mimetype, file.size, buf);

    const sha256 = createHash('sha256').update(buf).digest('hex');
    const safeName = sanitizeFileName(file.originalname);
    const storedPath = `${randomUUID()}-${safeName}`;
    writeFileSync(path.join(DATA_DIR, storedPath), buf);

    try {
      const doc = await this.prisma.document.create({
        data: {
          ownerSub: user.sub,
          fileName: safeName,
          mimeType: file.mimetype,
          sizeBytes: file.size,
          sha256,
          storedPath,
        },
      });
      await this.prisma.$transaction((tx) =>
        audit(tx, user.sub, 'document.upload', `${doc.id}:${safeName}`),
      );
      return {
        id: doc.id.toString(),
        fileName: doc.fileName,
        mimeType: doc.mimeType,
        sizeBytes: doc.sizeBytes,
        sha256: doc.sha256,
        createdAt: doc.createdAt,
      };
    } catch (err) {
      // pas de fichier orphelin si la BD refuse
      unlink(path.join(DATA_DIR, storedPath), () => {});
      throw err;
    }
  }

  /** Mes documents (métadonnées uniquement). */
  @Get('documents')
  @UseGuards(AuthGuard)
  async list(@Req() req: AuthRequest) {
    const user = req.user as TokenUser;
    const docs = await this.prisma.document.findMany({
      where: { ownerSub: user.sub },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, fileName: true, mimeType: true, sizeBytes: true,
        sha256: true, createdAt: true,
      },
    });
    return docs.map((d) => ({ ...d, id: d.id.toString() }));
  }

  /** Métadonnées d'un document du propriétaire. */
  @Get('documents/:id')
  @UseGuards(AuthGuard)
  async meta(@Req() req: AuthRequest, @Param('id') id: string) {
    const user = req.user as TokenUser;
    const doc = await this.prisma.document.findUnique({ where: { id: docIdOf(id) } });
    if (!doc || doc.ownerSub !== user.sub) throw new NotFoundException('document inconnu');
    return {
      id: doc.id.toString(), fileName: doc.fileName, mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes, sha256: doc.sha256, createdAt: doc.createdAt,
    };
  }

  /**
   * Partage (FR-04.2) : URL temporaire signée + QR de vérification.
   * Le propriétaire seul partage ; TTL borné ; jti révocable.
   */
  @Post('documents/:id/share')
  @UseGuards(AuthGuard)
  async share(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const user = req.user as TokenUser;
    const doc = await this.prisma.document.findUnique({ where: { id: docIdOf(id) } });
    if (!doc || doc.ownerSub !== user.sub) throw new NotFoundException('document inconnu');
    const b = (raw ?? {}) as { ttlSeconds?: unknown };
    const ttl = clampTtl(b.ttlSeconds);

    const share = await createShareToken(doc.id.toString(), user.sub, ttl);
    await this.prisma.$transaction(async (tx) => {
      await tx.shareToken.create({
        data: { jti: share.jti, documentId: doc.id, createdBy: user.sub, expiresAt: share.expiresAt },
      });
      await audit(tx, user.sub, 'share.grant', `${doc.id}:${share.jti}:ttl=${ttl}s`);
    });

    const contentUrl = `${PUBLIC_BASE}/documents/${doc.id}/content?t=${share.token}`;
    const verifyUrl = `${PUBLIC_BASE}/verify/${doc.id}?t=${share.token}`;
    const qrSvg = await QRCode.toString(verifyUrl, { type: 'svg', margin: 1 });
    return {
      jti: share.jti,
      url: contentUrl,
      verifyUrl,
      qrSvg,
      expiresAt: share.expiresAt,
    };
  }

  /** Révocation d'un partage déposé par l'authentifié. */
  @Delete('shares/:jti')
  @UseGuards(AuthGuard)
  async revoke(@Req() req: AuthRequest, @Param('jti') jti: string) {
    const user = req.user as TokenUser;
    const row = await this.prisma.shareToken.findUnique({ where: { jti } });
    if (!row || row.createdBy !== user.sub) throw new NotFoundException('partage inconnu');
    if (!row.revokedAt) {
      await this.prisma.$transaction(async (tx) => {
        await tx.shareToken.update({ where: { jti }, data: { revokedAt: new Date() } });
        await audit(tx, user.sub, 'share.revoke', `${row.documentId}:${jti}`);
      });
    }
    return { ok: true };
  }

  /** Téléchargement via URL signée — PUBLIC (le token fait foi). */
  @Get('documents/:id/content')
  async content(
    @Param('id') id: string,
    @Query('t') token: string,
    @Res() res: Response,
  ) {
    if (!token) throw new UnauthorizedException('lien signé requis');
    const share = await verifyShareToken(token);
    if (BigInt(share.did) !== docIdOf(id)) {
      throw new BadRequestException('lien ne correspond pas au document');
    }
    const row = await this.prisma.shareToken.findUnique({ where: { jti: share.jti } });
    if (!row || row.revokedAt || row.documentId.toString() !== share.did) {
      throw new UnauthorizedException('partage révoqué');
    }
    const doc = await this.prisma.document.findUnique({ where: { id: docIdOf(id) } });
    if (!doc) throw new NotFoundException('document inconnu');
    if (!isSafeStoredPath(doc.storedPath, DATA_DIR)) {
      throw new ForbiddenException('chemin stocké suspect');
    }
    // audit du téléchargement (non bloquant)
    void this.prisma
      .$transaction((tx) => audit(tx, share.sub, 'document.download', `${doc.id}:${share.jti}`))
      .catch(() => undefined);
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('X-Content-Safe-Checksum', doc.sha256);
    res.setHeader('Content-Disposition', `attachment; filename="${doc.fileName}"`);
    res.sendFile(path.resolve(DATA_DIR, doc.storedPath));
  }

  /**
   * Vérification publique (FR-04.3) : le QR pointe ici. Minimisation :
   * ni le nom du fichier ni le propriétaire ne sont exposés —
   * statut + empreinte + dates suffit à authentifier le document.
   */
  @Get('verify/:id')
  async verify(@Param('id') id: string, @Query('t') token: string) {
    if (!token) throw new UnauthorizedException('lien signé requis');
    const share = await verifyShareToken(token);
    if (share.did !== id.toString()) throw new BadRequestException('lien ne correspond pas au document');
    const row = await this.prisma.shareToken.findUnique({ where: { jti: share.jti } });
    if (!row || row.revokedAt) throw new UnauthorizedException('partage révoqué');
    const doc = await this.prisma.document.findUnique({ where: { id: docIdOf(id) } });
    if (!doc) throw new NotFoundException('document inconnu');
    return {
      valid: true,
      mimeType: doc.mimeType,
      sha256: doc.sha256,
      documentCreatedAt: doc.createdAt,
      linkExpiresAt: row.expiresAt,
    };
  }

  /** Suppression par le propriétaire : fichier + share tokens + row + audit. */
  @Delete('documents/:id')
  @UseGuards(AuthGuard)
  async remove(@Req() req: AuthRequest, @Param('id') id: string) {
    const user = req.user as TokenUser;
    const doc = await this.prisma.document.findUnique({ where: { id: docIdOf(id) } });
    if (!doc || doc.ownerSub !== user.sub) throw new NotFoundException('document inconnu');
    await this.prisma.$transaction(async (tx) => {
      await tx.shareToken.deleteMany({ where: { documentId: doc.id } });
      await tx.document.delete({ where: { id: doc.id } });
      await audit(tx, user.sub, 'document.delete', doc.id.toString());
    });
    unlink(path.join(DATA_DIR, doc.storedPath), () => {});
    return { ok: true };
  }
}

@Controller()
class HealthController {
  @Get('/healthz')
  health() {
    return {
      service: 'alveare-documents',
      status: 'ok',
      version: '0.1.0',
      bricks: ['upload-validated', 'signed-shares', 'public-verify', 'audit-minimal'],
    };
  }
}

@Module({
  controllers: [HealthController, DocsController],
  providers: [PrismaService],
})
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const port = Number.parseInt(process.env.DOCS_PORT ?? '4010', 10);
  await app.listen(port, 'localhost');
  console.log(`alveare-documents up : http://localhost:${port}/healthz`);
}
void bootstrap();
