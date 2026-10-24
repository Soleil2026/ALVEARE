/**
 * Tests pii — le noyau zone Red de notify (S1).
 * Clé injectée par le harnais (jamais la clé réelle de dev).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { hashRecipient, normalizeRecipient, openRecipient, sealRecipient } from '../src/pii';

const KEY = 'a'.repeat(64);

beforeAll(() => {
  process.env.NOTIFY_DATA_KEY = KEY;
});

describe('normalizeRecipient', () => {
  it('trim + lowercase, refus du vide', () => {
    expect(normalizeRecipient('  User@Dev.Local ')).toBe('user@dev.local');
    expect(() => normalizeRecipient('   ')).toThrow();
  });
});

describe('hashRecipient', () => {
  it('déterministe et insensible à la casse/espaces', () => {
    const a = hashRecipient('User@Dev.Local ');
    const b = hashRecipient(' user@dev.local');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it('discrimine les adresses distinctes', () => {
    expect(hashRecipient('a@dev.local')).not.toBe(hashRecipient('b@dev.local'));
  });
});

describe('sealRecipient / openRecipient', () => {
  it('round-trip JWE', async () => {
    const cipher = await sealRecipient('User@Dev.Local');
    expect(cipher).not.toContain('dev.local');
    expect(await openRecipient(cipher)).toBe('user@dev.local');
  });

  it('falsification → null (jamais d\'exception)', async () => {
    const cipher = await sealRecipient('a@dev.local');
    const parts = cipher.split('.');
    // JWE base64url : falsifier le 1er caractère du dernier segment
    // (tag GCM) est sûr ; le caractère final peut être indifférent par
    // le padding (même piège que la session web-admin).
    const seg = parts[4] ?? parts[3];
    parts[parts.length - 1] = (parts[parts.length - 1][0] === 'A' ? 'B' : 'A') + seg.slice(1);
    expect(await openRecipient(parts.join('.'))).toBeNull();
  });

  it('aucune adresse en clair dans le chiffre', async () => {
    const cipher = await sealRecipient('secret@domaine.tld');
    expect(cipher.includes('secret@')).toBe(false);
    expect(cipher.includes('domaine.tld')).toBe(false);
  });
});
