# Exploitation audit (E3) — partitions, drain, rétention

> Fiche opérateur du pipeline d'audit asynchrone (plan
> [E3-AUDIT-PLAN](plans/E3-AUDIT-PLAN.md), FR-03.1 à FR-03.3).
> Zone Red (piste d'audit) : toute opération ci-dessous touchant les
> partitions ou la rétention passe par un visa de revue indépendante.

## Vue d'ensemble

```
identity / documents / notify                    service audit :4030
  tx métier --INSERT--> audit.outbox --(drain BullMQ)--> audit.events
                                                (partitions mensuelles)
```

- Les émetteurs écrivent dans `audit.outbox` **dans leur transaction
  métier** (`auditOutbox` du paquet `@alveare/audit`) : si le commit
  passe, l'entrée d'audit existe — garantie outbox transactionnelle,
  aucun audit perdu même si tout le reste tombe.
- Le service `audit` (:4030, `services/audit`) transfère l'outbox vers
  `audit.events`, table **partitionnée mensuellement sur `at`**
  (migration `infra/audit-migrations/002-partition-events.sql`). Un
  SELECT sur la table mère traverse toutes les partitions — pas
  d'UNION manuel.
- Insertion **idempotente** : unicité `(outbox_id, at)` +
  `ON CONFLICT (outbox_id, at) DO NOTHING` — un double drain ne crée
  JAMAIS de doublon.

## Drain et queue BullMQ

- Queue unique : **`audit-drain`** (nom partagé entre le worker et le
  paquet `@alveare/audit`). Deux déclencheurs vers la même queue
  (plan E3 §2) :
  1. un **sweep répétable toutes les 30 s** — rattrapage universel :
     `SELECT … FROM audit.outbox WHERE delivered = false ORDER BY id
     LIMIT 100 FOR UPDATE SKIP LOCKED`, chaque lot traité dans sa
     transaction (lignes verrouillées, `SKIP LOCKED` : deux workers
     concurrents ne travaillent jamais le même lot) ;
  2. des **jobs signal** optionnels, enfilés après commit par les
     émetteurs via `signalDrain(connection)` (paquet
     `@alveare/audit`) — latence ≈ ms. Branchement des 3 émetteurs
     réservé à un commit SUIVANT (consigne T3.4).
- Retries : `attempts: 5`, backoff exponentiel 2 s (une ligne
  réfractaire est repérée par `attempts++` et reprise au sweep
  suivant, jamais perdue).
- Connection Redis : **`REDIS_URL`** (défaut
  `redis://localhost:6379/0` — Redis du compose
  `infra/docker-compose.yml`, appendonly déjà actif, aucun conteneur
  nouveau). Générée dans `.env` racine par `infra/mk-dotenv.sh`.
- Démarrage STRICT : Redis injoignable au boot = refus de démarrer
  (convention « aucun démarrage dégradé silencieux »).
- Arrêt gracieux : worker (fin du job en cours) → queue → connexion
  Redis → Prisma.

## Lecture admin (FR-03.3)

`GET /admin/audit` sur :4030 — gardes : rôle admin (cf. B §2.4) ;
filtres `actor`, `action`, `target`, `from`, `to` (ISO 8601) ;
`limit` 1..500 (défaut 50) ; pagination par curseur opaque
`?cursor=<base64url de "at|id">` — réponse
`{ items, nextCursor }`. SQL entièrement paramétré.

## Rétention (12 partitions glissantes)

- Partitions créées par la migration 002 ; aucune extension externe
  (pg_partman écarté au plan §2).
- Rotation : `bash infra/rotate-audit-partitions.sh <psql-uri:5432`
  (jamais via PgBouncer, cf. usage en tête du script) :
  - **MANUEL en V1** — cron différé à V2 ;
  - détache les partitions dont le mois est strictement antérieur à
    now − 12 mois ; ne DROP que si la partition détachée est VIDE —
    une partition non vide est conservée et son sort est une décision
    humaine. Rien n'est détruit sans preuve.

## Troubleshooting

| Symptôme | Piste |
|---|---|
| `audit.events` ne grossit pas alors que l'activité existe | outbox en attente : vérifier :4030 up + Redis joignable ; la latence sweep est ≤ 30 s — la ligne reste `delivered=false` jusqu'au rattrapage |
| :4030 refuse de démarrer | `REDIS_URL` absente/injoignable (init stricte : boot volontairement avorté) |
| jobs `audit-drain` en failed ×5 | échec d'une transaction de lot côté PostgreSQL — aucune perte : lignes restants `delivered=false`, `attempts++` visible dans audit.outbox, sweeps suivants retentent |
| doute sur des doublons | impossible par construction (unicité `(outbox_id, at)`) : vérifier `count(distinct outbox_id) == count(*)` sur audit.events |
| INSERT refuse (pas de partition pour ce mois) | `created_at` hors bornes des partitions créées : ajouter une partition couvrant ce mois (cf. migration 002) avant de drainer |
| compte « audit » dans les e2e identity/documents/notify | ces scripts comptent `events + outbox NON livrée` (tolérance à la latence du drain — cf. en-tête de `scripts/e2e-audit.sh`) |
