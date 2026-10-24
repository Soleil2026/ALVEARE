/**
 * Tests validate — parseSendInput pur (zone Red : aucune PII
 * re-émise dans les messages d'erreur).
 */

import { describe, expect, it } from 'vitest';
import { parseSendInput } from '../src/validate';

const base = {
  channel: 'email',
  template: 'verify-email',
  lang: 'fr',
  to: 'user@dev.local',
  via: 'identity',
};

describe('parseSendInput', () => {
  it('accepte un appel valide (email, sans params)', () => {
    const r = parseSendInput(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input.dedupKey).toBeUndefined();
  });

  it('accepte un SMS E.164 + params + dedupKey', () => {
    const r = parseSendInput({ ...base, channel: 'sms', to: '+33612345678', params: { code: '123456' }, dedupKey: 'k1' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.channel).toBe('sms');
      expect(r.input.dedupKey).toBe('k1');
    }
  });

  it('refuse channel/template/lang inconnus → 400', () => {
    for (const patch of [
      { channel: 'pigeon' },
      { template: 'nope' },
      { lang: 'de' },
    ]) {
      const r = parseSendInput({ ...base, ...patch });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(400);
    }
  });

  it('email malformé et sms non-E.164 → 400 (erreur générique)', () => {
    const bad = parseSendInput({ ...base, to: 'pas-email' });
    const badSms = parseSendInput({ ...base, channel: 'sms', to: '0612345678' });
    expect(bad.ok).toBe(false);
    expect(badSms.ok).toBe(false);
    if (!bad.ok) expect(bad.error).not.toContain('pas-email');
    if (!badSms.ok) expect(badSms.error).not.toContain('0612345678');
  });

  it('via manquant / trop long → 400', () => {
    expect(parseSendInput({ ...base, via: undefined }).ok).toBe(false);
    expect(parseSendInput({ ...base, via: 'x'.repeat(61) }).ok).toBe(false);
  });

  it('via non autorisé (app inconnue) → 400 (revue N5-4)', () => {
    expect(parseSendInput({ ...base, via: 'app-pirate' }).ok).toBe(false);
    expect(parseSendInput({ ...base, via: 'identity' }).ok).toBe(true);
    expect(parseSendInput({ ...base, via: 'e2e' }).ok).toBe(true);
  });

  it('params non chaînes ou trop de clés → 400', () => {
    expect(parseSendInput({ ...base, params: { code: 3 } }).ok).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 'v']));
    expect(parseSendInput({ ...base, params: many }).ok).toBe(false);
  });

  it('CRLF / tab dans les params → 400 (revue N5-5, injection headers)', () => {
    expect(parseSendInput({ ...base, params: { code: 'a\nb' } }).ok).toBe(false);
    expect(parseSendInput({ ...base, params: { code: 'a\rb' } }).ok).toBe(false);
    expect(parseSendInput({ ...base, params: { 'co\nde': 'a' } }).ok).toBe(false);
  });

  it('dedupKey hors bornes → 400', () => {
    expect(parseSendInput({ ...base, dedupKey: '' }).ok).toBe(false);
    expect(parseSendInput({ ...base, dedupKey: 'x'.repeat(121) }).ok).toBe(false);
  });
});
