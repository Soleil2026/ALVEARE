/**
 * Tests flood — cap 5 / destinataire / minute (état pur, harnais
 * contrôlé avec `now` injectable).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MAX_PER_WINDOW, WINDOW_MS, floodScore, resetFlood } from '../src/flood';

afterEach(() => resetFlood());

const NOW = 1_700_000_000_000;

describe('floodScore', () => {
  it('laisse passer MAX_PER_WINDOW puis bloque le suivant', () => {
    for (let i = 0; i < MAX_PER_WINDOW; i++) {
      expect(floodScore('hash-a', NOW + i * 1000).ok).toBe(true);
    }
    const last = floodScore('hash-a', NOW + MAX_PER_WINDOW * 1000);
    expect(last.ok).toBe(false);
    expect(last.remaining).toBe(0);
  });

  it('les destinataires sont indépendants', () => {
    for (let i = 0; i < MAX_PER_WINDOW; i++) floodScore('hash-a', NOW + i * 1000);
    expect(floodScore('hash-b', NOW).ok).toBe(true);
  });

  it('la fenêtre glissante réouvre après WINDOW_MS', () => {
    for (let i = 0; i < MAX_PER_WINDOW; i++) floodScore('hash-c', NOW + i * 1000);
    expect(floodScore('hash-c', NOW + WINDOW_MS).ok).toBe(true);
  });

  it('la fenêtre partielle reste bloquée', () => {
    for (let i = 0; i < MAX_PER_WINDOW; i++) floodScore('hash-d', NOW + i * 1000);
    expect(floodScore('hash-d', NOW + WINDOW_MS - 2_000).ok).toBe(false);
  });

  it('plafond émetteur custom (max param, revue N5-3)', () => {
    expect(floodScore('usr:u1', NOW, 2).ok).toBe(true);
    expect(floodScore('usr:u1', NOW + 1000, 2).ok).toBe(true);
    expect(floodScore('usr:u1', NOW + 2000, 2).ok).toBe(false);
    // un autre émetteur n'est PAS affecté
    expect(floodScore('usr:u2', NOW, 2).ok).toBe(true);
  });
});
