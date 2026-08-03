# Lovebox Blog Ops

Pipeline qui remplace les workflows n8n « SEO + IA Data Analyzer » et « Blog Audit Suppression » par un système plus puissant :

- **Suppression FULL-AUTO** des articles de blog morts (la seule action automatisée), encadrée par des garde-fous stricts, avec backup complet et redirection 301 systématiques.
- **Analyse complète** par 4 agents Claude (Sonnet 4.6) en parallèle — Analytics, SEO, Contenu, Visibilité IA — + un agent Master de synthèse, avec sorties JSON structurées (fini les rapports illisibles).
- **Rapport Slack exhaustif** à chaque run : suppressions exécutées (avec chemin du backup et cible 301), suppressions bloquées **avec la raison exacte**, diamants, pages à refresh, analyses des agents, actions de la semaine, KPIs.
- **Review pack** pour tout le reste : les actions non-suppression (refresh, maillage, fusion, noindex, arbitrages) sont écrites dans `review/<date>/REVIEW.md` + JSON, à traiter **par un humain en interactif avec Claude Code**.

## Architecture

```
src/
  index.js                CLI (doctor, audit, purge, weekly-report)
  lib/
    env.js                .env + chemins + vérification credentials
    google.js  ga4.js  gsc.js    Collecteurs Google (service account)
    shopify.js            Admin API : inventaire, backup, delete, 301
    classify.js           Tiers (MORT→TOP), clusters, diamants, refresh
    guardrails.js         Les garde-fous de suppression (le cœur de la sécurité)
    pipeline.js           Collecte + enrichissement + exécution suppressions
    claude.js             Les 5 agents Claude (sorties JSON par schéma)
    slack.js              Rapport Block Kit (message principal + thread détaillé)
    review-pack.js        Génération du pack d'actions humaines
    state.js              Historique des runs (data/history/)
  routines/
    audit.js              Voir le plan sans rien toucher
    purge.js              Supprimer (backup → delete → 301)
    weekly-report.js      Le gros run du lundi 7h (tout + agents Claude)
config/
  sites.json              Les 6 sites + clusters thématiques
  thresholds.json         Tous les seuils (tiers, suppression, refresh, diamants)
  protected-slugs.json    Slugs jamais supprimés, quoi qu'il arrive
```

## Garde-fous de suppression

Un article n'est supprimé **que si TOUTES** ces conditions sont vraies (90 jours) :

| Condition                    | Seuil (modifiable dans `config/thresholds.json`)      |
| ---------------------------- | ----------------------------------------------------- |
| Vues GA4                     | ≤ 5                                                   |
| Users GA4                    | ≤ 5                                                   |
| Clics Search Console         | 0                                                     |
| Impressions Search Console   | < 50                                                  |
| Sessions référées par des IA | 0                                                     |
| Engagement moyen             | ≤ 30 s                                                |
| Âge de l'article             | ≥ 180 jours                                           |
| Slug protégé                 | absent de `protected-slugs.json`                      |
| Données GSC disponibles      | obligatoire (pas de donnée = pas de suppression)      |
| Article matché dans Shopify  | obligatoire                                           |
| Plafond                      | max 15 suppressions par run (`MAX_DELETIONS_PER_RUN`) |

Et pour chaque suppression : **backup JSON complet** dans `data/backups/<SITE>/` (contenu HTML inclus, restaurable), puis DELETE Shopify, puis **redirect 301** vers le blog. Tout refus est rapporté sur Slack avec la raison exacte.

## Mise en route (quand tu as les credentials)

```bash
npm install
copy .env.example .env     # puis remplis chaque valeur (voir commentaires du fichier)
npm run doctor             # vérifie que tout est présent
npm run audit              # premier run : plan de suppression + rapport Slack, ne touche à rien
```

Quand le plan te convient :

```bash
# .env : DRY_RUN=false
npm run purge:confirm      # exécute les suppressions (backup + 301)
npm run weekly             # le rapport complet avec agents Claude (simulation)
node src/index.js weekly-report --confirm   # weekly avec suppressions réelles
```

### Planification (lundi 7h)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\schedule-windows.ps1
```

Crée deux tâches Windows : **Weekly Report** (lundi 07:00) et **Purge** (jeudi 07:30, rattrapage du plafond). Alternative si tu ne veux pas dépendre de ton PC allumé : les routines cloud de Claude Code (`/schedule` dans Claude Code) ou un runner GitHub Actions.

## Credentials à préparer (`.env.example` détaille tout)

1. **Anthropic** — clé API (console.anthropic.com).
2. **Google** — un service account avec _Analytics Data API_ + _Search Console API_ activées ; ajouter son email en lecteur sur la propriété GA4 et sur chaque propriété GSC.
3. **Shopify** — une app custom par boutique (EN/FR/EU) avec scopes `read_content`, `write_content` + écriture des redirects.
4. **Slack** — un bot `xoxb-` avec `chat:write`, invité dans le channel cible.

## Workflow humain (tout sauf la suppression)

Chaque run génère `review/<date>/REVIEW.md` : refresh, diamants, suppressions bloquées à arbitrer, actions stratégiques, tests. C'est volontairement **hors automatisation** — ouvre le dossier dans Claude Code :

```
claude "ouvre review/<date>/REVIEW.md et aide-moi à traiter les actions une par une"
```

## Restaurer un article supprimé

Les backups dans `data/backups/<SITE>/<slug>_<id>.json` contiennent l'article complet (`title`, `body_html`, `tags`, métadonnées). Pour restaurer : recréer l'article via l'admin Shopify ou demander à Claude Code de le re-poster via l'API, puis supprimer la redirection 301 correspondante.
