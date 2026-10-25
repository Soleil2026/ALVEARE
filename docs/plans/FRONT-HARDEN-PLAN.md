# PLAN — Retour front (durcissement session après F6)

Date : 2026-10-25 · Auteur : orchestrateur · Statut : **proposé — visa opérateur attendu**
Références : wiki [[front-oidc-raccord]] (leçons 4096 octets, revue F), code
`web/admin` (session.ts, page.tsx, callback/route.ts, logout/route.ts,
api/documents/route.ts, lib/oidc.ts). **Zone Red**.

## Constats (lecture du code aujourd'hui)

- C-1 Le `refresh_token` (`rt`) est déjà dans la session JWE et `refreshTokens()` existe (lib/oidc.ts:91), mais le refresh ne se déclenche QUE dans le proxy de documents (api/documents/route.ts:89) et UNIQUEMENT sur 401 d'upload POST. La page `/` (getState) et le GET du proxy ne renewent jamais un access token sur le point d'expirer — l'utilisateur est déconnecté inutilement alors qu'un rt valide dort dans son JWE.
- C-2 `/logout` reste un GET cliquable (logout/route.ts:12) — un lien `<a>` dans la page. Toute déconnexion devrait être POST (le GET est fetchable par un tiers — nuisance CSRF-logout ; SameSite=lax atténue déjà partiellement).
- C-3 `/callback` ne vérifie pas que la requête arrive bien sur l'host configuré dans REDIRECT_URI (l'attaque par code forcé/redirect sculpté est déjà freinée par state/PKCE/nonce, mais la vérification origin est la défense en profondeur consignée F-9).
- C-4 Le claim `idToken` reste dans SessionClaims/session.ts alors que le fix cookie-4096 VA le retirer partout — code mort qui invite à le re-stocker.
- C-5 Aucun garde-fou dynamique de la TAILLE du JWE sérialisé (la leçon 4096 octets n'est qu'humaine : si une feature future re-augmente le payload, le bug revient silencieusement).

## Le plan (S1..S4, puis revue N6)

### S1 — Renouvellement silencieux serveur (silent refresh)
- Fichier nouveau `web/admin/lib/ensure-session.ts` : `ensureFresh(session)` — si `exp - now < 90 s` et `session.rt` présent → `refreshTokens(rt)` → nouvelle session JWE ré-encodée (cap 12 h conservé). Échec de refresh → session « expired » (comportement actuel).
- Intégré dans : `page.tsx` (getState), proxy `api/documents` GET ET POST (le code 401-retry actuel y reste comme filet).
- Décision D-1 : renewal PAR rt stored (pas d'iframe prompt=none en V1) — simple, pas de JS navigateur, zéro token côté client.

### S2 — Logout en POST anti-CSRF
- `logout/route.ts` : POST uniquement (GET → 405) ; vérification `Origin/Referer` même host de déploiement ; cookie session détruit ; redirection KC end-session (inchangée).
- `page.tsx` : le lien `<a href="/logout">` devient `<form method="post" action="/logout">` (bouton stylé pareil).
- Décision D-2 : pas de token CSRF supplémentaire en V1 (SameSite=lax + vérif origin + POST-only suffisent aux revues OWASP de notre tier ; le token CSRF complet arrive avec les mutations de l'app métier — consigné).

### S3 — F-9 : vérification origin de /callback
- `callback/route.ts` : refus explicite si `req.nextUrl.host` ≠ host de `OIDC.redirectUri` (et protocole http/port conforme en dev) — fail() générique.
- Décision D-3 : strict host-check (pas de liste de hosts multiples en V1 — un seul déploiement par URI).

### S4 — Garde-fou taille session + nettoyage head de C-4
- `session.ts` : `encodeSession` logue (console.error) toute session sérialisée > 3500 octets — seuil bien en-deçà de la mort 4096 ; déclaration/lamento test après.
- Suppression du claim `idToken` de SessionClaims + du champ correspondant (parse/encode) — le fix 4096 est consolidé PAR LE CODE, pas juste par l'usage.
- Tests session (existant 13) étendus : session réaliste (at=JWT court simulé + rt) < 3500 ; refusal de l'ancien shape avec idToken n'est pas exigé (le champ n'existera plus).

### S5 — e2e + revue indépendante
- `scripts/e2e-front.sh` étendu : POST /logout sans origin → refusé mais session détruite ; GET /logout → 405 ; callback host étranger → échec ; silent refresh : échange avec expires_in court → renouvèlement transparent (session ré-encodée).
- Revue N6 (zone Red, auteur ≠ réviseur) → remédiation → commit → page wiki `front-durcissement` + index + log.

## Points de décision pour l'opérateur

1. D-1 : silent refresh PAR rt stored (serveur, pas d'iframe KC). OK ?
2. D-2 : logout POST-only + vérif origin (pas de token CSRF complet en V1, consigné pour la suite). OK ?
3. D-3 : /callback strict host-check (un seul host configuré). OK ?
4. D-4 : supprimer TOTALEMENT le claim `idToken` (consolidation du fix 4096 PAR LE CODE). OK ?
5. D-5 : seuil du garde-fou à 3500 octets (warn dynamique + test unitaire). OK ?
