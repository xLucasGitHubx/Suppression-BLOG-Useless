import fs from "node:fs";
import { env } from "./env.js";
import { logger } from "./logger.js";
import * as ga4 from "./ga4.js";
import * as gsc from "./gsc.js";
import * as shopify from "./shopify.js";
import {
  classifyArticles, clusterStats, findDiamonds, findRefreshCandidates,
  thresholds, editorialSites,
} from "./classify.js";
import { applyGuardrails } from "./guardrails.js";

/**
 * Collecte + classification + enrichissement + garde-fous.
 * C'est le cœur commun à audit, purge et weekly-report.
 */
export async function buildAuditDataset({ withShopify = true } = {}) {
  const windowDays = thresholds.windowDays;

  // --- Collecte en parallèle ---
  const [blogRows, previousBlogRows, llmRows, gscPagesBySite] = await Promise.all([
    ga4.blogPages(windowDays),
    ga4.blogPages(windowDays, windowDays), // fenêtre précédente (J-2×windowDays → J-windowDays), pour la tendance
    ga4.llmTraffic(windowDays),
    Promise.all(
      editorialSites.map(async (site) => [site.key, await gsc.pageMetrics(site.gscSiteUrl, windowDays)])
    ).then(Object.fromEntries),
  ]);

  const articles = classifyArticles(blogRows);

  // --- Index vues fenêtre précédente, par (site, slug) — pour la tendance ---
  const previousViewsBySlug = new Map();
  for (const a of classifyArticles(previousBlogRows)) previousViewsBySlug.set(`${a.siteKey}::${a.slug}`, a.views);

  // --- Index GSC par URL normalisée ---
  const gscByUrl = new Map();
  for (const rows of Object.values(gscPagesBySite)) {
    for (const row of rows) gscByUrl.set(row.page.replace(/\/$/, ""), row);
  }

  // --- Nombre de lignes GSC par site (santé de la donnée, pour l'inférence de zéro) ---
  const gscRowCountBySite = {};
  for (const [siteKey, rows] of Object.entries(gscPagesBySite)) gscRowCountBySite[siteKey] = rows.length;

  // --- Index slug → hosts vus en GSC, pour détecter les collisions cross-site ---
  const gscSlugHosts = new Map();
  for (const rows of Object.values(gscPagesBySite)) {
    for (const row of rows) {
      try {
        const u = new URL(row.page);
        const match = u.pathname.match(/\/blogs\/news\/([a-z0-9-]+)\/?$/i);
        if (!match) continue;
        const slug = match[1].toLowerCase();
        if (!gscSlugHosts.has(slug)) gscSlugHosts.set(slug, new Set());
        gscSlugHosts.get(slug).add(u.host);
      } catch { /* URL GSC malformée — ignorée */ }
    }
  }

  // --- Sessions LLM par URL ---
  const llmByUrl = new Map();
  for (const row of llmRows) {
    const url = `https://${row.hostName}${row.landingPage}`.replace(/\/$/, "");
    llmByUrl.set(url, (llmByUrl.get(url) || 0) + row.sessions);
  }

  // --- Inventaire Shopify (pour matcher les articles + récupérer l'âge) ---
  const shopifyIndex = new Map(); // `${siteKey}::${handle}` -> { blogId, article }
  if (withShopify) {
    for (const site of editorialSites) {
      try {
        const { blogId, articles: shopArticles } = await shopify.listArticles(site.shopifyEnv, site.blogHandle);
        for (const a of shopArticles) shopifyIndex.set(`${site.key}::${a.handle.toLowerCase()}`, { blogId, article: a });
        logger.info(`Shopify ${site.key}: ${shopArticles.length} articles inventoriés`);
      } catch (err) {
        logger.warn(`Inventaire Shopify ${site.key} impossible: ${err.message}`);
      }
    }
  }

  // --- Enrichissement des articles flaggés (les seuls candidats à suppression) ---
  const flagged = articles.filter((a) => a.flaggedForDeletion);
  for (const article of flagged) {
    const normalized = article.url.replace(/\/$/, "");
    const gscRow = gscByUrl.get(normalized) || null;
    article.gsc = gscRow;

    // Santé GSC du site (assez de lignes pour faire confiance à une absence = 0)
    article.gscSiteRowCount = gscRowCountBySite[article.siteKey] || 0;
    article.gscSiteHealthy = article.gscSiteRowCount >= thresholds.deletion.minGscRowsForInference;

    // Collision de slug : présent en GSC sous un host différent du site de l'article
    const hosts = gscSlugHosts.get(article.slug);
    article.gscSlugCollision = !!hosts && [...hosts].some((h) => h !== article.host);

    article.gscSource = gscRow
      ? "api"
      : thresholds.deletion.treatMissingGscAsZero
        ? "inferred-zero"
        : "unavailable";

    article.llmSessions = llmByUrl.get(normalized) || 0;
    const match = shopifyIndex.get(`${article.siteKey}::${article.slug}`);
    article.shopify = match ? { blogId: match.blogId, ...pickShopifyFields(match.article) } : null;
    article.live = await shopify.isLive(article.url);

    // Tendance : vues fenêtre courante vs fenêtre précédente (démarrage vs déclin).
    article.viewsPrevious = previousViewsBySlug.get(`${article.siteKey}::${article.slug}`) || 0;
    article.trend = deriveTrend(article.views, article.viewsPrevious);
  }

  // --- Vues 365j pour les articles flaggés ET saisonniers uniquement (pic annuel hors saison,
  //     pour ne pas alourdir la collecte sur tout le corpus) ---
  const seasonalFlagged = flagged.filter((a) => a.seasonal);
  if (seasonalFlagged.length) {
    const yearRows = await ga4.pageViewsForPaths(365, seasonalFlagged.map((a) => a.path));
    const yearViewsBySlug = new Map();
    for (const row of yearRows) {
      const site = editorialSites.find((s) => s.host === row.hostName);
      if (!site) continue;
      const match = row.pagePath.match(/\/blogs\/news\/([a-z0-9-]+)\/?$/i);
      if (!match) continue;
      const slug = match[1].toLowerCase();
      const key = `${site.key}::${slug}`;
      yearViewsBySlug.set(key, (yearViewsBySlug.get(key) || 0) + row.screenPageViews);
    }
    for (const article of seasonalFlagged) {
      article.viewsYear = yearViewsBySlug.get(`${article.siteKey}::${article.slug}`) || 0;
    }
  }

  const { approved, rejected } = applyGuardrails(flagged, env.maxDeletionsPerRun);

  const tierDistribution = {};
  for (const a of articles) tierDistribution[a.tier] = (tierDistribution[a.tier] || 0) + 1;
  const deadCount = (tierDistribution["MORT"] || 0) + (tierDistribution["TRÈS FAIBLE"] || 0);

  return {
    windowDays,
    articles,
    flagged,
    approved,
    rejected,
    diamonds: findDiamonds(articles),
    refreshCandidates: findRefreshCandidates(articles),
    clusterStats: clusterStats(articles),
    tierDistribution,
    llmRows,
    totals: {
      articlesAnalyzed: articles.length,
      flagged: flagged.length,
      approved: approved.length,
      deadRate: articles.length ? Math.round((deadCount / articles.length) * 100) : 0,
    },
  };
}

/**
 * Tendance simple : compare les vues de la fenêtre courante à la précédente.
 * Un article qui démarre (0 → quelques vues) ne doit pas être traité comme
 * un article qui meurt (beaucoup → quelques vues).
 */
function deriveTrend(views, viewsPrevious) {
  if (viewsPrevious === 0) return views > 0 ? "croissance" : "stable";
  if (views > viewsPrevious * 1.3) return "croissance";
  if (views < viewsPrevious * 0.7) return "déclin";
  return "stable";
}

function pickShopifyFields(a) {
  return {
    id: a.id,
    handle: a.handle,
    title: a.title,
    published_at: a.published_at,
    created_at: a.created_at,
    updated_at: a.updated_at,
    tags: a.tags,
  };
}

/**
 * Exécute les suppressions approuvées : backup → delete → 301.
 * Respecte DRY_RUN. Retourne la liste détaillée (pour le rapport).
 */
export async function executeDeletions(approved, { dryRun }) {
  const deletions = [];
  const errors = [];

  for (const article of approved) {
    const site = editorialSites.find((s) => s.key === article.siteKey);
    const redirectTo = site.redirectFallback;
    try {
      // Récupère l'article complet (body_html inclus) — pickShopifyFields/article.shopify
      // ne garde que les champs légers utilisés par les garde-fous, pas le contenu.
      const fullArticle = await shopify.getArticle(site.shopifyEnv, article.shopify.blogId, article.shopify.id);
      const backupFile = shopify.backupArticle(article.siteKey, {
        ...fullArticle,
        auditSnapshot: {
          views: article.views, users: article.users,
          engagementSeconds: article.engagementSeconds,
          gsc: article.gsc, gscSource: article.gscSource, llmSessions: article.llmSessions,
          tier: article.tier, cluster: article.cluster,
        },
      });

      // Fail-safe : on ne supprime jamais sans backup complet (body_html non vide).
      const persisted = JSON.parse(fs.readFileSync(backupFile, "utf8"));
      if (!persisted.article?.body_html || !persisted.article.body_html.trim()) {
        errors.push(`Suppression ${article.siteKey}/${article.slug}: backup incomplet (body_html absent) — suppression annulée par sécurité`);
        logger.error(`Backup incomplet pour ${article.slug}, suppression annulée`);
        continue;
      }

      if (!dryRun) {
        await shopify.deleteArticle(site.shopifyEnv, article.shopify.blogId, article.shopify.id);
        await shopify.createRedirect(site.shopifyEnv, article.path, redirectTo);
      }

      deletions.push({ ...article, backupFile, redirectTo, executed: !dryRun });
    } catch (err) {
      errors.push(`Suppression ${article.siteKey}/${article.slug}: ${err.message}`);
      logger.error(`Échec suppression ${article.slug}`, err.message);
    }
  }

  return { deletions, errors };
}
