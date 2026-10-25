# Plan E3 — Audit : pipeline asynchrone BullMQ + partitions

> **Statut : VALIDÉ (T3.0, 2026-10-25)** — outbox transactionnel,
> 3 émetteurs (identity/documents/notify), API lecture dédiée au
> service `audit` :4030, rétention 12 mois glissants. « ok todos »
> acquis, exécution lancée. **Zone Red** (piste d'audit = sécurité et
> traces) — revue indépendante obligatoire (auteur ≠ réviseur).

## 1. Objectif et base PRD

Exigences FR-03.1 à FR-03.3 (PRD ALVEARE Core V1, §3) :

- **FR-03.1** journal des opérations sensibles : connexions, partages
  de données, exports, téléchargements, suppressions, élévations de rôle ;
- **FR-03.2** écriture asynchrone via BullMQ, tables partitionnées
  mensuelles (playbook ADR-0002) ;
- **FR-03.3** requête d'audit admin filtrable : qui / quoi / quand / où.

État des lieux (exploration du dépôt, 2026-10-25) : l'audit est déjà
écrit de façon **synchrone** par identity, documents et notify (INSERT
SQL brut dans `audit.events`, souvent à l'intérieur de la transaction
métier — pour documents/notify c'est même bloquant-dans-tx par exigence
de revue). E3 industrialise ce mécanisme sans casser ces garanties.

## 2. Problématique de conception (décision clé)

L'audit d'une opération sensible **ne doit jamais pouvoir être perdu** :
si une opération métier réussit mais que son entrée d'audit disparaît
(crash entre le commit et l'enfilement BullMQ), la piste est trouée —
c'est le premier point qu'un réviseur zone Red bloquerait.

**Solution retenue (proposée) : outbox transactionnel.**

1. Les émetteurs (identity / documents / notify) remplacent leur INSERT
   `audit.events` par un INSERT dans `audit.outbox` **dans la même
   transaction métier** (garantie identique à celle d'aujourd'hui : si
   la transaction est committée, l'audit est forcément présent).
2. Le nouveau service `services/audit` (:4030) transfère outbox →
   `audit.events` via BullMQ, avec deux mécanismes de déclenchement :
   a) après commit, un job « drain » est enfilé (latence ≈ ms) ;
   b) un balayage périodique (30 s, idempotent, `SELECT … FOR UPDATE
   SKIP LOCKED`) rattrape tout job de signal perdu.
3. L'insertion dans les partitions est idempotente (unicité sur
   l'identifiant d'outbox source) : double drain = zéro doublon.

Alternatives écartées :
- enqueue après commit seul — perte possible au crash (rejeté) ;
- tout sync dans la table partitionnée — pas d'asynchrone, contredit
  FR-03.2 ;
- pg_partman — extension non nécessaire pour 12 partitions gérées par
  script.

## 3. Schéma de données

- `audit.outbox` (nouvelle) : `id bigserial`, `created_at timestamptz`,
  `payload jsonb NOT NULL` (entrée d'audit complète), `delivered boolean
  DEFAULT false`, `attempts int DEFAULT 0`.
- `audit.events` : convertie en table **partitionnée RANGE mensuelle sur
  `at`** (colonnes actuelles conservées : `id bigserial, at, actor,
  action, target, details jsonb`). PK `(id, at)` (la clé de partition
  doit être incluse dans la clé primaire), index sur `(actor)`,
  `(action)`, `(at)`, unicité `outbox_id` pour l'idempotence du drain.
- Migrations = SQL brut versionné dans `infra/` (précédent E1,
  postgres-init.sh) ; la conversion est un script idempotent testé sur
  copie ; migrations toujours en direct `:5432`, jamais via PgBouncer.
- Rétention V1 : 12 partitions ; script `infra/rotate-audit-partitions.sh`
  (detach + drop > 12 mois) documenté, déclenchement manuel (cron en V2).

## 4. Service `services/audit` (:4030)

Socle modèle : notify (NestJS 11, PrismaService, AuthGuard `@alveare/auth`,
 `enableShutdownHooks`, initialisation stricte avant listen) :

- **Worker BullMQ** : queue `audit-drain` (REDIS_URL du compose existant,
  appendonly déjà actif, aucun nouveau conteneur) — le job répartit un
  lot d'entrées vers la partition du mois correspondant, avec
  retries en backoff exponentiel ; balayage de sécurité périodique.
- **API lecture FR-03.3** : `GET /admin/audit` — filtres `actor`,
  `action`, `target`, `from`, `to`, pagination par curseur ; validation
  Zod dans `@alveare/contracts` (`AuditQuery`) ; accès réservé au rôle
  admin ; service-agnostic (lit les partitions).
- `GET /healthz` : `{ service, status, bricks }` (convention existante).

## 5. Émetteurs

- Package `@alveare/audit` : helper `auditOutbox(tx, entry[])` appelé
  dans la transaction métier. Le caractère bloquant-dans-tx est
  **conservé** (c'est un INSERT local pas cher) — exigence de la revue
  C3 pour documents/download.
- Refactor des 3 services : supprimer les INSERT directs vers
  `audit.events`, passer par le helper.
  - identity : logins, consent.grant / consent.revoke, role_grants ;
  - documents : document.upload, share.grant / share.revoke,
    document.download, document.delete ;
  - notify : notify.send, notify.sent / notify.failed.
- Endpoint hérité `GET /admin/audit` d'identity : déprécié (réponse
  inchangée + header `Deprecation`), bascule du backoffice vers :4030.

## 6. Tâches

- **T3.0** gate opérateur (cette page + les questions ouvertes du chat)
- **T3.1** migrations SQL : outbox, conversion partitionnée de events,
  indexes, idempotence — preuve psql
- **T3.2** `@alveare/contracts` : `AuditEntry`, `AuditQuery` ;
  `@alveare/audit` : helper outbox
- **T3.3** refactor émetteurs identity / documents / notify (tests
  verts à chaque service)
- **T3.4** `services/audit` : scaffold :4030, worker BullMQ + balayage,
  healthz
- **T3.5** API `GET /admin/audit` filtrable + pagination + dépréciation
  de l'endpoint hérité
- **T3.6** rétention : script rotate + doc exploitation
- **T3.7** tests vitest (helper outbox, drain idempotent, filtres,
  balayage) + `scripts/e2e-audit.sh` (preuves numérotées, format
  e2e-notify)
- **T3.8** revue indépendante zone Red (auteur ≠ réviseur) + remédiation
- **T3.9** livraison : page wiki `e3-audit-livraison` + visa opérateur

## 7. Ordonnancement

T3.0 → T3.1 → T3.2 → T3.3 (parallélisable par service) → T3.4 → T3.5 →
T3.6 → T3.7 → T3.8 → T3.9.

## 8. Risques notés (pour la revue)

1. PgBouncer transaction pooling + SQL partitionné : connexions
   transaction-pooling et DDL/queues à vérifier explicitement — test
   e2e dédié à travers le pooler (précédent E1 : 29 preuves).
2. BullMQ/Redis : DB index 0, aucun nouveau conteneur ; le sweep doit
   couvrir la perte du job de signal (test de crash simulé).
3. Conversion de la table existante avec données : script testé sur
   copie, plan de retour arrière documenté (sauvegarde `events_bak`).
4. Aucun double-écriture transitoire : bascule des émetteurs contrôlée
   par le flag `AUDIT_PIPELINE` (ancien chemin conservé tant que la
   file n'est pas prouvé verte).

## 9. Critères de fin (checklist de livraison)

- [ ] docker compose up : `audit` :4030 healthz = 200 ; worker connecté
  à Redis
- [ ] upload document → entrée présente dans la partition du mois en
  moins de 2 s (via job) et lisible par GET /admin/audit filtré
- [ ] après drain : outbox vide idempotent ; sweep rattrape un job
  perdu
- [ ] 12 partitions présentes (mois courant + 11 glissants) via script
- [ ] tests vitest verts pour les 4 packages concernés
- [ ] `scripts/e2e-audit.sh` vert suite complète
- [ ] revue indépendante signée : 0 MAJEUR non remédié
- [ ] accord opérateur final avant commit de clôture
