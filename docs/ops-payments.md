# Runbook — service Paiements :4040 (E6, zone Red)

> Service ALVEARE Integrations : adapters CIB/Edahabia. Source de vérité
> design : `docs/plans/E6-PAIEMENTS-PLAN.md` (gates T4.0 validés
> 2026-10-25) + `docs/research/E6-PAIEMENTS-RESEARCH.md`. Zone Red
> (argent, réglementaire) — toute modification passe par la revue
> critique indépendante (AGENTS.md §3).

## 1. Ce que fait le service

- **POST /payments** — création idempotente (unicité `(app, app_ref)`),
  checkout **redirect hosted** de l'adapter actif ; `created → pending`.
- **GET /payments/:id** — lecture par l'app propriétaire OU admin
  (réconciliation de rattrapage côté app, plan §2.2).
- **POST /payments/:id/refund** — partiel/total, plafond ≤ payé,
  idempotent par `refund_ref` (Q9) ; replay = no-op, même refund_ref +
  autre montant = 409.
- **POST /payments/webhook** — entrée PSP ; signature renouvelée
  (chargily), idempotent par `event_uid` (unicité) ; transition via la
  machine à états stricte, 409 sur transition illégale.
- **GET /admin/payments?app=&status=&limit=** — lecture admin
  (AdminGuard, miroir FR-03.3).
- **Sweeps** (30 s, gabarit worker E3) :
  1. **réconciliation** — `fetchStatus` de l'adapter sur chaque
     `pending` : source de vérité serveur (R2 : en SATIM V2 c'est
     le SEUL canal) ;
  2. **expiry** — `pending` silencieuse > `PAYMENTS_TTL_SECONDS`
     (défaut 1200 s, miroir auto-cancel SATIM) → `expired`, watchdog
     `console.error` structuré (alerting à brancher).
- **Webhooks sortants** — queue BullMQ `payments-webhooks-out` :
  POST signé `X-ALVEARE-Signature: t=<unix>, v1=<hmac `t.body`>` ;
  secret PAR APP issu de `payments.app_endpoints.secret` (jamais
  loggé) ; retries backoff exponentiel ; après le plafond
  `PAYMENTS_WEBHOOK_ATTEMPTS_CAP` (défaut 5) → ligne dans
  `payments.webhook_dead` + `console.error` structuré
  (`event: dead_letter`) + trace audit `payment.webhook.dead`.
- **Audit (héritage E3)** — chaque mouvement est écrit au
  `audit.outbox` DANS la transaction métier (outbox transactionnel) :
  `payment.created`, `payment.paid|failed|expired`,
  `payment.refunded`, `payment.webhook.sent|dead`. Le service
  enfiling un signal `signalDrain` pour le drain :4030.

## 2. Adapters (fabrique STRICTE)

`PAYMENTS_PROVIDER` (env, défaut `dev`) — hors liste acceptée = boot
refusé (aucun démarrage dégradé) :

| Adapter | Usage | réseau |
|---|---|---|
| `dev` | tests + e2e + dév loc. Simulation déterministe : journal JSONL (`PAYMENTS_DEV_OUTBOX`, le `redirect_url` devient la page `dev-checkout`, statut maîtrisé par `POST /payments/:id/dev-confirm` \| `dev-fail` (gardes EXPLICITES `ALV_ALLOW_E2E=1` + provider `dev`). | zéro |
| `chargily` | Chargily Pay v2 : REST checkout hosted, sandbox par défaut (base `/test/`), `CHARGILY_SECRET_KEY` requise au boot sinon REFUS. LIVE = KYB opérateur (hors code). Les tests unitaires n'appellent JAMAIS le réseau (fetch injectable). | sandbox |
| `satim` | V2 : boot refusé en V1 ; spécification + checklist d'homologation en annexe (§5). | V2 |

## 3. Secrets / variables d'environnement

Toutes posées via l'addendum idempotent de `infra/mk-dotenv.sh` (les
variables déjà présentes gagnent ; jamais écrasées) + placeholder dans
`infra/.env.example` :

| Clé | défaut | rôle |
|---|---|---|
| `PAYMENTS_PROVIDER` | `dev` | adapter actif (boot STRICT refusé sinon) |
| `PAYMENTS_WEBHOOK_ATTEMPTS_CAP` | `5` | plafond de tentatives avant DLQ |
| `PAYMENTS_WEBHOOK_MAX_SKEW` | `300` | fenêtre anti-replay t/v1 en secondes |
| `PAYMENTS_TTL_SECONDS` | `1200` | silence avant auto-expiry des pending |
| `CHARGILY_SECRET_KEY` | — | secret sandbox Chargily (compte opérateur) ; requis UNIQUEMENT si provider=chargily (refus de boot sinon) |
| `PAYMENTS_DEV_OUTBOX` | `/tmp/alv-payments-dev.jsonl` | journal de la PSP fictive (jamais versionné) |
| `PAYMENTS_PORT` | `4040` | port d'écoute |

Secret webhook SORTANT par app : stocké en
`payments.app_endpoints.secret` (BD) — génération au provisionnement (psql / seed). **Jamais dans
le code, jamais commit, jamais loggé** (le HMAC transporté n'est pas un
secret). Rotation = UPDATE de la ligne + coordonner avec l'app (les
webhooks en vol au moment de la rotation peuvent être rejetés : re-
checker par GET réconciliation).

## 4. Essayer en local (dev)

```bash
bash infra/mk-dotenv.sh            # variables E6 (addendum idempotent)
psql "$DATABASE_NO_SCHEMA" -f infra/audit-migrations/006-payments.sql
pnpm --filter @alveare/payments-service run dev    # :4040, provider dev
```

(seed d'app provisionné dans `scripts/e2e-payments.sh` : exemple de
l'INSERT idempotent avec secret généré à l'exécution, jamais committé ;
en production, utiliser un seed revu + un secret par app. Ce qui est
posé dans `payments.app_endpoints.secret` est :

```sql
INSERT INTO payments.app_endpoints (app, url, secret)
VALUES ('app-01', 'http://127.0.0.1:46180/hooks/app-01', '<secret généré>')
ON CONFLICT (app) DO UPDATE SET url = EXCLUDED.url, secret = EXCLUDED.secret;
```

- e2e complet : `bash scripts/e2e-payments.sh` (10 preuves numérotées ;
  le script boote son propre :4040 avec TTL/cap court, aucun secret
  affiché).

Inspecter la DLQ :
`SELECT * FROM payments.webhook_dead ORDER BY dead_at DESC LIMIT 20;`
Rattrapage d'un événement mort : l'état du DB est déjà correct — l'app
rattrape les données par GET /payments/:id (livraison rejouée =
dédupliquée par event_uid côté app).
Purge opérateur (tracée et revue, jamais automatique) :
`DELETE FROM payments.webhook_dead WHERE dead_at < now() - interval '30 days';`.

## 5. ANNEXE — Checklist d'homologation SATIM V2 (risque R4)

> Rail direct (webmarchand via banque acquéreur). Sources :
> satim.dz, BDL webmarchand, kayen.dev (2025). Dossier
> (OPÉRATEUR, chemin critique R6) : registre de commerce →
> dépôt dossier CIBweb → GIE Monétique (< 24 h) →
> tests/certification →
> autorisation → contrat de banque domiciliataire (compte pro).

### Environnements

| env | rôle |
|---|---|
| `test2.satim.dz` | tests de CERTIFICATION (10 000 DA HT/jour ouvrable, BDL) |
| `test.satim.dz` | tests dev sans certification |
| `cib.satim.dz` | PRODUCTION |

### API webmarchand (uniforme au rail)

- `register.do` — POST redirect : centimes, `currency=012` (DZD),
  `jsonParams` 3-lang (fr/ar/en), `udf1` = code app (routage Q7).
- `public/acknowledgeTransaction.do` — ACK OBLIGATOIRE après la page
  retour sinon auto-cancel (miroir de notre sweep expiry).
- `getOrderStatusExtended.do` — réconciliation = SOURCE DE VÉRITÉ
  (**aucun webhook serveur→serveur SATIM**, R2).
- `refund.do` — montant ≤ payé ; refund payé 8 DA ; min 100 DA.

### Checklist de certification (tampon)

- [ ] SSL valide sur le domaine de paiement (.dz, loi 18-05 hébergement).
- [ ] Montant SUR LA PAGE, en évidence (dès l'arrivée).
- [ ] CGV/conditions accessibles AVANT validation.
- [ ] **CAPTCHA sur le bouton « Payer »** (figé côté app, exigence SATIM).
- [ ] Logos CIB + Edahabia affichés visiblement.
- [ ] **N° 3020 en IMAGE** (jamais texte) sur la page retour + le reçu.
- [ ] Langage UNIQUE par session (fr / ar / en, AR = RTL).
- [ ] Reçu imprimable / PDF.
- [ ] **Redirect page SATIM hébergée** (iframe interdit à la certification).
- [ ] `acknowledgeTransaction` implémenté et testé (sinon auto-cancel).
- [ ] Scénarios de cartes CIB/Edahabia d'essais fournis par le testeur —
      réussite, échec bout (3D-Secure), expiration, annulation manuelle.
- [ ] Test remboursement + annulation sur la même commande.
- [ ] Réconciliation `getOrderStatusExtended` : pending > 20 min →
      `expired` (miroir auto-cancel SATIM) vérifié, aucun état faux.
- [ ] Certificat/attestation (validité 2 ans) reçu et archivé.

### Coûts BDL (grille publique, 2026)

Adhésion 50 000 DA HT ; abo N+1 10k→150k DA ; serveur de test
10 000 DA HT/jour ouvrable ; commission 10 DA HT si ≤ 5 000 DA sinon
0,7 % plafonné 300 DA ; refund 8 DA ; min 100 DA.

## 6. Changer de PROVIDER (procédure)

1. Poser les pré-requis du nouveau rail dans le `.env` (secret sandbox)
   via `infra/mk-dotenv.sh` (variables déjà présentes ne sont PAS
   écrasées) ou à la main.
2. `PAYMENTS_PROVIDER=chargily` (env du service), redémarrer : boot
   vérifie le secret (`CHARGILY_SECRET_KEY`) et la fabrique — refus de
   démarrer si inconnu/absent (jamais de fallback silencieux).
3. Vérifier la SANDBOX avec la procédure §4 (create → paid → refund)
   via un POST cobaye app-01 ; le e2e `e2e-payments.sh` reste calé sur
   provider `dev` (aucun contact réseau par défaut).
4. Les transactions en vol changent de rail : NE PAS utiliser deux
   adapters ensemble sur le MÊME webmarchand ; basculer uniquement à
   une fenêtre calme (aucune `pending` en attente : sweep suspendu ou
   réponse PSP ok).
5. Vérifier que les `webhook_dead` de l'ancien rail sont vidés (DLQ
   rattrapée) AVANT la bascule.
