/**
 * Tests render — templates i18n (fr/ar/en), échappement HTML,
 * strictness (un paramètre manquant = erreur, jamais un {{...}} au
 * destinataire). Charge le VRAI répertoire templates du service.
 */

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { htmlEscape, loadTemplates, render, substitute } from '../src/render';

const TPLS = loadTemplates(path.resolve(__dirname, '../templates'));

describe('loadTemplates', () => {
  it('4 templates × 3 langues présents (strict)', () => {
    expect(TPLS.size).toBe(4);
    for (const perLang of TPLS.values()) {
      expect(perLang.size).toBe(3);
      for (const [lang, tpl] of perLang) {
        expect(tpl.subject.length).toBeGreaterThan(3);
        expect(tpl.text.length).toBeGreaterThan(10);
        expect(['fr', 'ar', 'en']).toContain(lang);
      }
    }
  });
});

describe('substitute', () => {
  it('remplace, échappe et refuse le manquant', () => {
    expect(substitute('code {{code}}', { code: '123456' })).toBe('code 123456');
    expect(() => substitute('code {{code}}', {})).toThrow('paramètre {{code}} manquant');
  });
});

describe('htmlEscape', () => {
  it('neutralise toute injection HTML', () => {
    expect(htmlEscape('<script src="x">a&b</script>')).toBe(
      '&lt;script src=&quot;x&quot;&gt;a&amp;b&lt;/script&gt;',
    );
  });
});

describe('render', () => {
  it('fr → paragraphe simple, pas de dir', () => {
    const r = render(TPLS, 'test', 'fr', { message: 'bonjour <b>toi</b>' });
    expect(r.subject).toContain('Message de test');
    expect(r.html).toContain('<p>');
    expect(r.html).not.toContain('dir="rtl"');
    // Injection neutralisée
    expect(r.html).toContain('&lt;b&gt;toi&lt;/b&gt;');
    expect(r.html).not.toContain('<b>toi</b>');
  });

  it('ar → dir="rtl" lang="ar", contenu arabe', () => {
    const r = render(TPLS, 'verify-email', 'ar', { code: '4242', link: 'https://x', ttl: '10 min' });
    expect(r.html).toContain('dir="rtl"');
    expect(r.html).toContain('lang="ar"');
    expect(r.html).toContain('رمز التحقق');
  });

  it('en → envoyé tel quel sans rtl', () => {
    const r = render(TPLS, 'verify-email', 'en', { code: '4242', link: 'https://x', ttl: '10 min' });
    expect(r.html).not.toContain('dir="rtl"');
    expect(r.subject).toBe('ALVEARE — Verify your email address');
  });

  it('paramètre manquant → erreur stricte (pas de {{...}} livré)', () => {
    expect(() => render(TPLS, 'verify-email', 'fr', { code: '4242' })).toThrow(
      'paramètre {{link}} manquant',
    );
  });

  it('document-shared : nom de doc échappé', () => {
    const r = render(TPLS, 'document-shared', 'fr', {
      docName: 'Momente <A1>.pdf',
      link: 'https://x',
      ttl: '2 h',
    });
    expect(r.html).toContain('Momente &lt;A1&gt;.pdf');
  });
});
