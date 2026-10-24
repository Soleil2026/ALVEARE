/**
 * @alveare/documents — validation des fichiers uploadés (zone Red).
 * Allowlist mime + magic bytes + taille + nom nettoyé (pas de
 * path traversal). Remplace `file-type` (ESM-only) par des magic
 * bytes manuels — V1 : pdf / png / jpeg / csv / xlsx.
 */

import { BadRequestException } from '@nestjs/common';
import * as path from 'node:path';

export const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? '10');

/** fail-fast : une limite de taille invalide = service dangereusement muet */
if (!Number.isFinite(MAX_UPLOAD_MB) || MAX_UPLOAD_MB <= 0) {
  throw new Error(`MAX_UPLOAD_MB invalide : ${String(process.env.MAX_UPLOAD_MB)}`);
}

/** mime → signature binaire attendue (HEAD du fichier) */
const MAGICS: Array<{
  mime: string; exts: string[]; head: (b: Buffer) => boolean;
}> = [
  { mime: 'application/pdf', exts: ['.pdf'], head: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/png', exts: ['.png'], head: (b) => b.subarray(0, 4).toString('hex') === '89504e47' },
  { mime: 'image/jpeg', exts: ['.jpeg', '.jpg'], head: (b) => b.subarray(0, 2).toString('hex') === 'ffd8ff' },
  {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    exts: ['.xlsx'],
    head: (b) => b.subarray(0, 2).toString('hex') === '504b' && b.length >= 8,
  },
];

/** csv : extension seule + contenu textuel raisonnable (pas de NUL). */
const CSV = { mime: 'text/csv', exts: ['.csv'] };

export function allowedMimes(): string[] {
  return [...MAGICS.map((m) => m.mime), CSV.mime];
}

/** Nom de fichier nettoyé : basename + whitelist caractères + borne. */
export function sanitizeFileName(raw: string): string {
  const base = raw.split('/').pop() ?? '';
  const cleaned = base.replace(/[^\w .\-]/g, '_').replace(/^\.+/, '_').slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'sans-nom';
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i).toLowerCase();
}

/** Valide mime déclaré + taille + magic bytes (+ ext si fournie). */
export function validateUpload(
  mimeType: string,
  sizeBytes: number,
  buf: Buffer,
  fileName?: string,
): void {
  if (sizeBytes <= 0) throw new BadRequestException('fichier vide');
  const max = MAX_UPLOAD_MB * 1024 * 1024;
  if (sizeBytes > max) {
    throw new BadRequestException(`fichier trop gros (max ${MAX_UPLOAD_MB} Mo)`);
  }
  if (!allowedMimes().includes(mimeType)) {
    throw new BadRequestException('type de fichier non autorisé');
  }
  if (fileName) {
    const ext = extOf(fileName.toLowerCase());
    const rule = MAGICS.find((m) => m.mime === mimeType);
    const ok =
      mimeType === CSV.mime
        ? CSV.exts.includes(ext)
        : !!rule && rule.exts.includes(ext);
    if (!ok) {
      throw new BadRequestException('extension incompatible au type déclaré');
    }
  }
  if (mimeType === CSV.mime) {
    if (buf.includes(0)) throw new BadRequestException('csv binaire non valide');
    return;
  }
  const rule = MAGICS.find((m) => m.mime === mimeType);
  if (!rule || !rule.head(buf)) {
    throw new BadRequestException('contenu non conforme au type déclaré');
  }
}

/** Contrôle défensif : le chemin stocké reste sous le dossier data. */
export function isSafeStoredPath(stored: string, dataDir: string): boolean {
  const abs = path.resolve(dataDir, stored);
  return abs.startsWith(path.resolve(dataDir) + path.sep);
}
