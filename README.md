# ALVEARE — plateforme produite (Core + 12 apps)

Dépôt **code de production** de l'écosystème VISA VOYAGE / ALVEARE.

Le dépôt **connaissance** (cahier des charges interprété, ADR, PRD,
wiki) vit dans le dépôt voisin `ALVEARETOP` — c'est la source de vérité
documentaire ; chaque livrable de code y est documenté.

## Références (dans ALVEARETOP)

- `wiki/pages/decisions/` — ADR (stack, orchestration, structure)
- `wiki/pages/core/PRD-alveare-core-v1.md` — PRD Core V1 (input des chantiers)
- `raw/B.cahier-des-charges-architecture.md` — exigences non négociables

## Structure (E1)

```
packages/contracts   # Zod + types partagés (contract-first)
services/            # backends NestJS (briques Core puis apps)
web/                 # frontends Next.js
infra/               # docker-compose (Traefik, Keycloak, Redis, PgBouncer, Infisical)
docs/                # PRODUCT.md des briques (B §5.4)
```

## Hygiène

- `.env` est **jamais** commité (secrets → Infisical) — règle non négociable.
- Zones Red (auth, paiements, données personnelles) : revue indépendante
  obligatoire, auteur ≠ réviseur.
