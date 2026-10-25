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
     `SELECT … FROM audit.outbox WHERE delivered = false AND attempts
     < plafond ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`, chaque
     lot traité dans sa transaction (lignes verrouillées,
     `SKIP LOCKED` : deux workers concurrents ne travaillent jamais
     le même lot) ;
  2. des **jobs signal** optionnels, enfilés après commit par les
     émetteurs via `signalDrain(connection)` (paquet
     `@alveare/audit`) — latence ≈ ms ; la queue est **partagée au
     niveau du processus** (créée à la première utilisation,
     réutilisée ensuite — revue T3.8 R-1). Branchement des 3
     émetteurs réservé à un commit SUIVANT (consigne T3.4 ; latence
     garantie en attendant : ≤ 30 s via le sweep).
- Retries : `attempts: 5`, backoff exponentiel 2 s (une ligne
  réfractaire est repérée par `attempts++` et reprise au sweep
  suivant, jamais perdue — JUSQU'AU PLAFOND, cf. quarantaine
  ci-dessous).
- **Plafond de tentatives** : env **`AUDIT_ATTEMPTS_CAP`** (entier > 0,
  défaut 5, générée dans `.env`/`infra/.env` par `infra/mk-dotenv.sh`).
  Le drain ne re-sélectionne plus une ligne à `attempts >= cap`.
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
`{ items, nextCursor }`. SQL entièrement paramétré. Index dédié
`(at DESC, id DESC)` (migration 005 : pagination sans tri complet). Taxonomie d'erreurs
(revue T3.8 R-2) : un curseur illisible → **400** ; tout autre échec
BD → **500** avec trace serveur (jamais masqué en 400).

## Quarantaine (dead-letter) et runbook

Le plafond `AUDIT_ATTEMPTS_CAP` transforme une ligne réfractaire en
quarantaine — fin de l'auto-retry, jamais de perte de trace :

- table **`audit.outbox_deadletter`** (migration 003) :
  `id` (ligne outbox source), `quarantined_at`, `attempts`, `payload`
  (copié TEL QUEL — même non conforme) et `error` (raison, ex.
  « plafond de tentatives atteint ») ;
- sur chaque lot, le drain déplace en dead-letter les lignes livrées
  avec `attempts >= cap` : copie `INSERT` puis `DELETE` du outbox,
  **deux énoncés séparés dans la même transaction** (piège de snapshot
  des CTE modifiantes ; cf. `services/audit/src/drain.ts`), puis log
  `audit drain : quarantaine de N ligne(s) réfractaire(s)` — JAMAIS
  silencieux ;
- **runbook** :
  1. inspecter la ligne :
     `SELECT * FROM audit.outbox_deadletter WHERE quarantined_at > now() - interval '1 day';`
  2. si la cause est réparée (version du service, payload corrigé) :
     réinsérer dans le outbox avec `attempts = 0`
     (`INSERT INTO audit.outbox (payload, attempts) VALUES (<payload>, 0);`)
     — le drain la reprendra au sweep suivant ;
  3. sinon conserver la trace (jamais d'effacement automatique : la
     dead-letter est une piste d'audit, sa purge est une décision
     humaine).

## Rétention et maintenance des partitions

- Script de maintenance : **`infra/audit-migrations/rotate-audit-partitions.sh`**
  (un run = trois phases, dans cet ordre) :
  1. **création continue** : partitions manquantes de la fenêtre
     **[mois courant − 1 .. mois courant + 2]** (tampon avant/après,
     auto-réparation — bornes identiques à la migration 002) ;
  2. **purge outbox** — OPTIONNELLE : `--purge-outbox N` (N mois)
     supprime les lignes **livrées** (`delivered = true`) plus vieilles
     que N mois. DÉSACTIVÉE par défaut ;
     **frontière** : cette purge ne supprime JAMAIS rien de
     `audit.events` — l'audit final vit dans `audit.events`,
     l'outbox n'est qu'un relais ;
  3. **rétention 12 mois glissants** : détache les partitions dont le
     mois est strictement antérieur à now − 12 mois (cutoff recalculé
     à chaque exécution) ; ne DROP que si la partition détachée est
     VIDE — une partition non vide est conservée et son sort est une
     décision humaine.
- **Mode `--check`** (lecture seule, utilisé par l'e2e) : exit 0 si
  TOUTES les partitions [courant − 1 .. courant + 2] existent, exit 1
  sinon.
- Idempotent et re-runnable : rien à faire = NOTICE + exit 0.
- Exécution : psql direct **:5432**, jamais via PgBouncer
  (usage en tête du script, URI jamais commitée).
- Déclenchement (plan E3 §3) : **V1 manuel** (fiche ci-dessus) ;
  cron suggéré à partir de V2 :
  `13 2 * * * bash infra/audit-migrations/rotate-audit-partitions.sh --purge-outbox 12 <uri-lue-du-.env> >> /var/log/audit-rotate.log 2>&1`
  (l'opérateur garde le contrôle : la purge d'outbox n'existe QUE
  quand `--purge-outbox` est passé explicitement).

## Troubleshooting

| Symptôme | Piste |
|---|---|
| `audit.events` ne grossit pas alors que l'activité existe | outbox en attente : vérifier :4030 up + Redis joignable ; la latence sweep est ≤ 30 s — la ligne reste `delivered=false` jusqu'au rattrapage |
| lignes s'accumulent en `delivered=false` avec `attempts` qui montent | retries en cours ; au plafond (`AUDIT_ATTEMPTS_CAP`, défaut 5) elles passent automatiquement en `audit.outbox_deadletter` (détail dans « Quarantaine » et son runbook) |
| :4030 refuse de démarrer | `REDIS_URL` absente/injoignable (init stricte : boot volontairement avorté) |
| jobs `audit-drain` en failed ×5 | échec d'une transaction de lot côté PostgreSQL — aucune perte : lignes restants `delivered=false`, `attempts++` visible dans audit.outbox, sweeps suivants retentent |
| `GET /admin/audit` → 400 « curseur illisible » | curseur corrompu côté client : repartir d'un `nextCursor` frais (jamais un échec BD : un vrai échec BD répond 500 avec trace serveur) |
| doute sur des doublons | impossible par construction (unicité `(outbox_id, at)`) : vérifier `count(distinct outbox_id) == count(*)` sur audit.events |
| INSERT refuse (pas de partition pour ce mois) | `created_at` hors bornes des partitions créées : lancer le script de maintenance (création continue de la fenêtre [courant−1..courant+2]) ou ajouter la partition à la main (cf. migration 002) |
| compte « audit » dans les e2e identity/documents/notify | ces scripts comptent `events + outbox NON livrée` (tolérance à la latence du drain — cf. en-tête de `scripts/e2e-audit.sh`) |
