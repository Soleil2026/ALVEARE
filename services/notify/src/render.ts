/**
 * @alveare/notify — rendu des templates (S3, FR-05.2).
 * - Templates = fichiers JSON `templates/<template>/<lang>.json`
 *   chargés STRICTEMENT au démarrage : si un couple manque (fr/ar/en),
 *   le service refuse de démarrer (aucun fallback silencieux).
 * - Substitution {{cle}} : valeur manquante = erreur (jamais un
 *   "{{...}}" envoyé au destinataire).
 * - HTML : échappement complet des valeurs (zone Red : les params
 *   d'app ne doivent jamais injecter du HTML — phishing).
 * - AR : l'enveloppe porte dir="rtl" lang="ar".
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Lang, Template } from './validate';
import { LANGS, TEMPLATES } from './validate';

export type Tpl = { subject: string; text: string };
export type TemplatesMap = Map<Template, Map<Lang, Tpl>>;

/** Charge et vérifie la complétude template × langue. Échoue dur. */
export function loadTemplates(root: string): TemplatesMap {
  const map: TemplatesMap = new Map();
  for (const template of TEMPLATES) {
    const perLang = new Map<Lang, Tpl>();
    for (const lang of LANGS) {
      const file = path.join(root, template, `${lang}.json`);
      const raw = readFileSync(file, 'utf8') as string;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.subject !== 'string' || typeof parsed.text !== 'string') {
        throw new Error(`template incomplet : ${template}/${lang}`);
      }
      perLang.set(lang, { subject: parsed.subject, text: parsed.text });
    }
    map.set(template, perLang);
  }
  return map;
}

/** Substitution {{cle}} — valeur manquante = erreur stricte. */
export function substitute(text: string, params: Record<string, string> | undefined): string {
  return text.replace(/\{\{(\w{1,30})\}\}/g, (m, key: string) => {
    const v = params?.[key];
    if (typeof v !== 'string') {
      throw new Error(`paramètre {{${key}}} manquant`);
    }
    return v;
  });
}

/** Échappement HTML complet des valeurs interpolées. */
export function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type Rendered = { subject: string; text: string; html: string };

/** Rend le sujet/texte/HTML d'un template pour une langue. */
export function render(
  templates: TemplatesMap,
  template: Template,
  lang: Lang,
  params: Record<string, string> | undefined,
): Rendered {
  const tpl = templates.get(template)?.get(lang);
  if (!tpl) {
    throw new Error(`template introuvable : ${template}/${lang}`);
  }
  const subject = substitute(tpl.subject, params);
  const text = substitute(tpl.text, params);
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => `<p>${htmlEscape(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  const rtl = lang === 'ar';
  const html =
    `<!doctype html><html lang="${lang}"${rtl ? ' dir="rtl"' : ''}>` +
    `<head><meta charset="utf-8"></head><body>${paragraphs}</body></html>`;
  return { subject, text, html };
}
