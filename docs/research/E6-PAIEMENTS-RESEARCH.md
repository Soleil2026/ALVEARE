# Recherche E6 — ALVEARE Integrations / service Paiements (adapters)

> Date : 2026-10-25. Rapport compilé depuis la recherche de préparation
> (subagent d'exploration, session ses_e8b6a67f4ffelzJxO84NC7EWhI) —
> zéro code écrit. Alimente le plan `docs/plans/E6-PAIEMENTS-PLAN.md`.
> Toute affirmation web est datée ; toute référence repo est fichier:ligne.

## 1. Périmètre PRD / coupe exacte

- `wiki/pages/core/PRD-alveare-core-v1.md:39` — brique **Integrations**,
  V1 = « adapters paiements », justification « CIB/Edahabia = points
  d'entrée du service Paiements » ; report V2 = « cartographie,
  livraison » (**non-goals** explicites E6).
- `raw/B.cahier-des-charges-architecture.md:558` — fonctions minimales
  du service : transactions, factures, reçus, remboursements,
  rapprochement et journalisation.
- `raw/B…:464-465` — `PAYMENT_CONFIRMED` produit par le service
  paiements, consommé par l'**application propriétaire de la
  transaction** ; entrant : `ORDER_CREATED` depuis les apps.
- `raw/B…:67` — paiements = service transversal **zone Red**; CRM hors
  Core (appartient aux verticales, `PRD…:133-136`).

## 2. Rails / adapters candidats (attestés)

⚠️ Noms invérifiables écartés (« BaridiCharge », « Zetaas pay », etc. —
aucune trace sur CIBweb/SATIM). Liste = acteurs attestés par pages
officielles.

### Rail 1 — SATIM direct (webmarchand via banque acquéreur)

Source : satim.dz (integration webmarchand, 2026-10-25) ; BDL
(www.bdl.dz/webmarchand, 2026-10-25) ; kayen.dev/guides
(cib-edahabia-payment-integration, 2026-08-05) ; berkati (2026-10-04).

- Process : dossier **cibweb.dz** + registre de commerce → GIE Monétique
  < 24 h → tests + certification → autorisation → contrat banque
  domiciliataire (compte pro obligatoire).
- Coûts BDL (seule grille publique) : adhésion **50 000 DA HT** ; abo
  N+1 10 000 → 150 000 DA ; **serveur de test 10 000 DA HT/jour
  ouvrable** ; commission **10 DA HT si ≤ 5 000 DA, sinon 0,7 %
  plafonné 300 DA** ; refund 8 DA ; min 100 DA.
- API : `register.do` (centimes, currency `012`, AR/FR/EN, `udf1`) /
  `public/acknowledgeTransaction.do` (**obligatoire**, auto-cancel
  sinon) / `refund.do` (≤ montant payé) ; envs `test2.satim.dz`
  (certif), `test.satim.dz`, **`cib.satim.dz` = prod**.
- **AUCUN webhook serveur→serveur** — la réconciliation
  (`getOrderStatusExtended.do`) est la seule source de vérité ; retour
  utilisateur = simple signal à vérifier.
- Parcours **redirect page SATIM hosted** (iframe interdit à la
  certification), 3DS/OTP natif, DZD only, **PCI SAQ A**.
- Exigences certification : SSL, montant en évidence, CGV, **CAPTCHA
  sur le bouton payer**, logos CIB/Edahabia, **n° 3020 en image** sur
  page retour + reçu, langage unique, reçu imprimable/PDF, scénarios de
  cartes de test, test remboursement+annulation, certificat 2 ans.

### Rail 2 — PSP certifiés SATIM (« third profile » CIBweb)

Source : cibweb.dz/fr/modules-autorise (2026-10-25). Modules
certifiés : Guiddini, EBLINK, ADEXEPAY, ALPAY/CONEX, Mpay, MYBUSI,
shipili store, Web Rocket, 3SPAY, ATA CORP (NC/02/000063/2026).

**Chargily Pay** (chargily.com/dz/business/pay/pricing +
dev.chargily.com/pay-v2/webhooks, 2026) :
- API REST v2, checkout hosted, **sandbox gratuite et immédiate** (avant
  KYC), SDK 7 langages.
- Tarifs : Starter **0 %** (300 tx ou 300 000 DZD/mois) ; Comfort
  **1,5 %** (min 15/max 1 500 DZD) ; Supreme 3 % ; Elite 4,5 % ;
  **refund 2 %** (min 20/max 2 000) ; payout hors quota 1,5 % (min
  150 DA) ; wallets DZD/EUR/USD.
- **Webhooks POST signés : entête `signature` = HMAC-SHA256** du secret
  API, réponse 200 attendue. KYB après sandbox pour le live. CIB +
  Edahabia au contrat.
- Risques : commission > rail direct ; délais de payout non publiés ;
  solde bloqué 24–72 h selon plan.

**SlickPay** (slick-pay.com, 2026-10-25) : 2 % (payout instant) → 1,4 %
mensuel ; package npm ; webhook non documenté publiquement.

Marché : interop CIB↔Edahabia depuis le **23/12/2021** ; Edahabia
≈ 13,4 M porteurs vs CIB ≈ 4,2 M mi-2024 → activer les deux au contrat.

### Rail 3 — International (clients étrangers)

- **Stripe** : non disponible compte marchand DZ (algeriatech.news,
  2026-01-29). **PayPal** DZ : réception conditionnée, 4,9 % + fixe.
- Convibilité DZD ≈ 30 démarches / 3–6 mois — non viable en flux.
- **BDL e-commerce international** (Visa puis Mastercard, lancement
  public juin 2025 ; page màj 2026-05-24) : **5 %/tx** + pack anti-fraud
  **65 000 DA HT/mois** + dossier **70 000 DA HT** ; secteurs nommés :
  assurance, transport aérien/maritime, location de voitures,
  **tourisme (réservation/hébergement)** → APP-01/APP-03 en cible
  explicite ; prérequis : compte domicilié BDL, accord de
  confidentialité, contrat webmarchand, demande manuscrite, business
  plan.

### Rail 4 — Annexe

- Switch paiement instantané national à la SATIM (P2P/P2B/QR, Gulf Bank
  premier connecté) — rail V2 plausible (progresssoft.com, 2025-01-15).
- Recrédit CIB/Edahabia après refund : 1–5 j ouvrés (compensation
  GIE/SATIM/Algérie Poste).

## 3. Contraintes du code existant (touchpoints ALVEARE)

- Port **4040 libre** : 4000/4010/4020/4030 pris (identity/documents/
  notify/audit, `main.ts` de chaque service).
- **Adapter pattern validé zone Red** : `SmsProvider` + fabrique par
  var d'env, **boot refusé si provider inconnu**, adaptateur `dev` →
  JSONL (`services/notify/src/sms.ts:12-34`) → transposable :
  `PAYMENTS_PROVIDER=dev|chargily|satim`.
- **Outbox + drain réutilisables** : `auditOutbox()`
  (`packages/audit/src/index.ts:65-129`), `signalDrain` coalescé
  (`packages/audit/src/drain-signal.ts:64-94`), gabarit worker avec
  sweep répétable + close propre (`services/audit/src/main.ts:115-183`)
  — chercher le **pattern**, pas une duplication de code.
- **Idempotence éprouvée** : `dedupKey` + unicité scoppée + gestion
  `P2002` (`services/notify/src/main.ts:128-136, 200-214`).
- **`@alveare/contracts` : aucun schéma PAYMENT** (69 lignes) →
  `PaymentCreate/Status/WebhookPayload/Refund` à créer (patterns
  datetime/bigint-safe déjà fixés l.29-67).
- **Auth/guards** : `ALLOWED_AZP` + extension dev-only + garde-mort e2e
  (`packages/auth/src/index.ts:31-99`) ; AdminGuard par grant
  `core-admin` (`services/audit/src/main.ts:93-106`) ; scoping app prêt
  via `APP_PATTERN` (`services/identity/src/grants.ts:11`).
- **Infra** : Redis 8 (appendonly) + PgBouncer :6432 transaction
  pooling ; migrations direct :5432 (`infra/docker-compose.yml:22-55`) ;
  **pas d'ingress public pour un webhook receiver en dev** (postman /
  service app factice en local) ; secrets → `infra/mk-dotenv.sh`.
- **Restes E3** : latence drain sweep 30 s tant que `signalDrain` n'est
  pas branché ; monitoring partitions + alerte dead-letter en suivi
  (`AGENTS.md` §5 ; `E3-AUDIT-PLAN.md:165-171`).

## 4. Gates T4.0 (décisions opérateur 2026-10-25)

| Gate | Décision |
|---|---|
| Q1 Rail MVP | **Adapters : PSP MVP + SATIM V2** (PSP = Chargily Pay, sandbox gratuite) |
| Q2 Parcours | **Redirect hosted exclusif** (SAQ A) |
| Q3 Réseaux | **CIB + Edahabia V1**, BDL-intl = adaptateur séparé V2 |
| Q4 Apps | **Webhook signé HMAC-SHA256 (BullMQ) + GET réconciliation** |
| Q5 Reçu | **Reçu minimal persisté** (réf n° 3020 exposée), facture V2 |
| Q6 Journal | **Outbox traces + `payments.transactions` état-machine + statuts `PAYMENT_*` versionnés dans contracts** |
| Q7 Marchand | **1 webmarchand Core**, app portée par `udf1`/metadata |
| Q8 FX | **Champs rail/currency/justificatif_ref dès V1** |
| Q9 Refund | **Partiel/total idempotent** (≤ montant payé) |

## 5. Risques + rollback

| # | Risque | Atténuateur |
|---|---|---|
| R1 | Réglementaire BA juillet 2025 (billetterie indirecte en devise obligatoire, justificatifs) | Q8 : champs dès le schéma V1 |
| R2 | Aucun webhook SATIM ; retour perdu → pending infini | Sweep réconciliation = source de vérité ; auto-cancel SATIM 20 min → état `expired` |
| R3 | Serveur de test SATIM 10 000 DA HT/jour | Adapter `dev` + e2e **avant** toute homologation |
| R4 | Certification SATIM (CAPTCHA, n° 3020, scénarios cartes) | Checklist intégrée au runbook (V2 SATIM) |
| R5 | Dépendance PSP (frais, payout) | Multi-adapters ADR-0002:117 ; `PAYMENTS_PROVIDER` ; ligne `providerFee` tracée |
| R6 | Dossier administratif CIBweb (RC, fichier fournisseurs, hébergement .com.dz — loi 18-05) | **Chemin critique de l'OPÉRATEUR** (pas du code) ; code livré/testé en `dev` pendant la procédure |
| R7 | International inutilisable (Stripe/PayPal) hors BDL-intl | V2 adaptateur séparé, avant-gardiste au schéma (Q8) |

Rollback / safety : state machine `created → pending → paid | failed |
expired ; paid → partially_refunded → refunded ; pending > 20 min →
expired` — états terminaux immuables, transitions illégales refusées ;
idempotency key sur create/webhook/refund ; réconciliation peer-first ;
`PAYMENTS_PROVIDER=dev` = aucun contact réseau ; alertes dead-letter +
watchdog à la sauce E3 ; contrats `PAYMENT_*` figés avant branchement
d'app (B l.472-478).
