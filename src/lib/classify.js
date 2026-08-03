import { loadConfig } from "./env.js";
import { logger } from "./logger.js";

const sitesConfig = loadConfig("sites");
const thresholds = loadConfig("thresholds");

const editorialSites = sitesConfig.sites.filter((s) => s.type === "editorial");
const excludeRegexes = thresholds.urlExcludePatterns.map((p) => new RegExp(p, "i"));

export function siteForHost(host) {
  return sitesConfig.sites.find((s) => s.host === host) || null;
}

export function clusterForSlug(slug) {
  for (const [cluster, keywords] of Object.entries(sitesConfig.clusters)) {
    if (keywords.some((kw) => slug.includes(kw))) return cluster;
  }
  return "other";
}

const seasonalKeywords = sitesConfig.seasonalKeywords || [];

/** Détecte les slugs saisonniers (Noël, Saint-Valentin, etc.) — mêmes marqueurs que `clusters`. */
export function isSeasonal(slug) {
  return seasonalKeywords.some((kw) => slug.includes(kw));
}

export function tierForViews(views) {
  const t = thresholds.tiers;
  if (views <= t.MORT) return "MORT";
  if (views <= t.TRES_FAIBLE) return "TRÈS FAIBLE";
  if (views <= t.FAIBLE) return "FAIBLE";
  if (views <= t.MOYEN) return "MOYEN";
  if (views <= t.BON) return "BON";
  return "TOP";
}

export function actionForTier(tier) {
  return {
    "MORT": "SUPPRIMER",
    "TRÈS FAIBLE": "SUPPRIMER",
    "FAIBLE": "SURVEILLER",
    "MOYEN": "CONSERVER",
    "BON": "RENFORCER",
    "TOP": "PRIORITAIRE",
  }[tier];
}

/**
 * Transforme les lignes GA4 brutes en articles classifiés.
 * Filtre URLs invalides, dédoublonne par (site, slug) en sommant les vues.
 */
export function classifyArticles(ga4Rows) {
  const bySlug = new Map();
  const discarded = { unknownHost: 0, excludedPattern: 0, invalidSlug: 0 };

  for (const row of ga4Rows) {
    const site = siteForHost(row.hostName);
    if (!site || site.type !== "editorial") { discarded.unknownHost++; continue; }
    if (excludeRegexes.some((re) => re.test(row.pagePath))) { discarded.excludedPattern++; continue; }

    const match = row.pagePath.match(/\/blogs\/news\/([a-z0-9-]+)\/?$/i);
    if (!match) { discarded.invalidSlug++; continue; }
    const slug = match[1].toLowerCase();

    const key = `${site.key}::${slug}`;
    const existing = bySlug.get(key);
    if (existing) {
      existing.views += row.screenPageViews;
      existing.users += row.totalUsers;
      existing.engagementTotal += row.userEngagementDuration;
    } else {
      bySlug.set(key, {
        siteKey: site.key,
        host: site.host,
        slug,
        url: `https://${site.host}${site.blogPathPrefix}${slug}`,
        path: `${site.blogPathPrefix}${slug}`,
        views: row.screenPageViews,
        users: row.totalUsers,
        engagementTotal: row.userEngagementDuration,
      });
    }
  }

  const articles = [];
  for (const a of bySlug.values()) {
    const tier = tierForViews(a.views);
    articles.push({
      ...a,
      engagementSeconds: a.views > 0 ? Math.round((a.engagementTotal / a.views) * 10) / 10 : 0,
      tier,
      action: actionForTier(tier),
      cluster: clusterForSlug(a.slug),
      seasonal: isSeasonal(a.slug),
      flaggedForDeletion: a.views <= thresholds.deletion.maxViews90d,
    });
  }
  articles.sort((x, y) => x.views - y.views);

  const totalDiscarded = discarded.unknownHost + discarded.excludedPattern + discarded.invalidSlug;
  if (totalDiscarded > 0) {
    logger.warn(
      `classifyArticles: ${totalDiscarded} lignes GA4 écartées (host inconnu: ${discarded.unknownHost}, pattern exclu: ${discarded.excludedPattern}, slug invalide: ${discarded.invalidSlug})`
    );
  }

  return articles;
}

/** Stats agrégées par cluster (dead rate, vues totales) pour l'analyse. */
export function clusterStats(articles) {
  const stats = {};
  for (const a of articles) {
    stats[a.cluster] ??= { total: 0, dead: 0, views: 0 };
    stats[a.cluster].total++;
    stats[a.cluster].views += a.views;
    if (a.tier === "MORT" || a.tier === "TRÈS FAIBLE") stats[a.cluster].dead++;
  }
  for (const s of Object.values(stats)) {
    s.deadRate = s.total ? Math.round((s.dead / s.total) * 100) : 0;
  }
  return stats;
}

/** Diamants : fort engagement, faible visibilité → à pousser (humain). */
export function findDiamonds(articles) {
  const d = thresholds.diamond;
  return articles
    .filter((a) => a.engagementSeconds >= d.minEngagementSeconds && a.views <= d.maxViews90d && a.views > thresholds.deletion.maxViews90d)
    .sort((x, y) => y.engagementSeconds - x.engagementSeconds)
    .slice(0, 10);
}

/** À refresh : fort trafic, engagement quasi nul → à retravailler (humain). */
export function findRefreshCandidates(articles) {
  const r = thresholds.refresh;
  return articles
    .filter((a) => a.views >= r.minViews90d && a.engagementSeconds <= r.maxEngagementSeconds)
    .sort((x, y) => y.views - x.views)
    .slice(0, 10);
}

export { thresholds, sitesConfig, editorialSites };
