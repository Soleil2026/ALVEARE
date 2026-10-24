/*
 * Tests validation fichiers (zone Red) — magic bytes, mime, nom.
 */

import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { isSafeStoredPath, sanitizeFileName, validateUpload } from '../src/files';

const PDF = Buffer.from('%PDF-1.4 fake pdf', 'utf8');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('validateUpload', () => {
  it('accepte un PDF conforme à sa signature', () => {
    expect(() => validateUpload('application/pdf', PDF.length, PDF)).not.toThrow();
  });

  it('accepte un PNG conforme à sa signature', () => {
    expect(() => validateUpload('image/png', PNG.length, PNG)).not.toThrow();
  });

  it('rejette le mime non allowlist', () => {
    expect(() => validateUpload('application/x-msdownload', 10, PNG)).toThrow(BadRequestException);
  });

  it('rejette le contenu qui ne colle pas au mime déclaré', () => {
    expect(() => validateUpload('image/png', PDF.length, PDF)).toThrow(BadRequestException);
  });

  it('rejette un fichier vide', () => {
    expect(() => validateUpload('application/pdf', 0, Buffer.alloc(0))).toThrow(BadRequestException);
  });

  it('rejette un fichier trop gros', () => {
    const big = Buffer.concat([PDF, Buffer.alloc(11 * 1024 * 1024)]);
    expect(() => validateUpload('application/pdf', big.length, big)).toThrow(BadRequestException);
  });

  it("rejette un csv contenant des octets nuls", () => {
    const evil = Buffer.concat([Buffer.from('a,b,c\n'), Buffer.from([0, 1, 2])]);
    expect(() => validateUpload('text/csv', evil.length, evil)).toThrow(BadRequestException);
  });

  it('accepte un csv textuel propre', () => {
    const csv = Buffer.from('a,b,c\n1,2,3\n', 'utf8');
    expect(() => validateUpload('text/csv', csv.length, csv)).not.toThrow();
  });
});

describe('sanitizeFileName', () => {
  it('réduit au basename sans arborescence', () => {
    expect(sanitizeFileName('/tmp/../../etc/passwd')).toBe('passwd');
  });

  it('neutralise les caractères suspects', () => {
    const out = sanitizeFileName('a<b>|*.pdf');
    expect(out).not.toMatch(/[<>|*]/);
  });

  it('borne la longueur', () => {
    expect(sanitizeFileName('x'.repeat(500) + '.pdf').length).toBeLessThanOrEqual(120);
  });
});

describe('isSafeStoredPath', () => {
  const dir = '/tmp/alveare-data';
  it("refuse une évasion ('..')", () => {
    expect(isSafeStoredPath('../outside.pdf', dir)).toBe(false);
  });
  it('accepte un chemin interne', () => {
    expect(isSafeStoredPath('uuid-test.pdf', dir)).toBe(true);
  });
});
