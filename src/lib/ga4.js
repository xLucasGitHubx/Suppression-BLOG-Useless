import { env, loadConfig } from "./env.js";
import { googleRequest } from "./google.js";
import { logger } from "./logger.js";

const API = "https://analyticsdata.googleapis.com/v1beta";
const llmSources = loadConfig("llm-sources").sources;

function dateRange(days, offsetDays = 0) {
  return {
    startDate: `${days + offsetDays}daysAgo`,
    endDate: offsetDays ? `${offsetDays}daysAgo` : "today",
  };
}

async function runReport(body) {
  return googleRequest(`${API}/properties/${env.ga4PropertyId}:runReport`, body);
}

/**
 * Comme runReport, mais pagine via `offset` tant que rowCount (annoncé par
 * l'API) n'est pas atteint. Évite les troncatures silencieuses sur les
 * rapports volumineux (ex. blogPages avec limit fixe).
 */
async function runReportPaged(body) {
  const pageSize = body.limit || 25000;
  let offset = 0;
  let merged = null;
  let rowCount = 0;
  for (;;) {
    const report = await runReport({ ...body, limit: pageSize, offset });
    rowCount = report.rowCount ?? (report.rows || []).length;
    if (!merged) merged = { dimensionHeaders: report.dimensionHeaders, metricHeaders: report.metricHeaders, rows: [] };
    const rows = report.rows || [];
    merged.rows.push(...rows);
    offset += rows.length;
    if (rows.length === 0 || merged.rows.length >= rowCount) break;
  }
  if (rowCount && merged.rows.length < rowCount) {
    logger.warn(`GA4 runReportPaged: troncature — ${merged.rows.length}/${rowCount} lignes récupérées`);
  }
  return merged;
}

function rowsToObjects(report) {
  const dims = (report.dimensionHeaders || []).map((d) => d.name);
  const mets = (report.metricHeaders || []).map((m) => m.name);
  return (report.rows || []).map((row) => {
    const o = {};
    dims.forEach((d, i) => (o[d] = row.dimensionValues[i].value));
    mets.forEach((m, i) => (o[m] = Number(row.metricValues[i].value)));
    return o;
  });
}

/**
 * Toutes les pages blog (/blogs/news/) sur la fenêtre, avec host + path,
 * vues, users, durée d'engagement. C'est le dataset central de l'audit.
 * `windowDays` et `offsetDays` permettent de décaler la fenêtre (ex. période
 * précédente pour la détection de tendance, ou fenêtre longue pour la
 * saisonnalité) — même mécanisme que `periodComparison`.
 */
export async function blogPages(windowDays, offsetDays = 0) {
  const merged = await runReportPaged({
    dateRanges: [dateRange(windowDays, offsetDays)],
    dimensions: [{ name: "hostName" }, { name: "pagePath" }],
    metrics: [
      { name: "screenPageViews" },
      { name: "totalUsers" },
      { name: "userEngagementDuration" },
    ],
    dimensionFilter: {
      filter: {
        fieldName: "pagePath",
        stringFilter: { matchType: "CONTAINS", value: "/blogs/news/" },
      },
    },
    orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
    limit: 25000,
  });
  const rows = rowsToObjects(merged);
  logger.info(`GA4 blogPages (${windowDays}j${offsetDays ? `, offset ${offsetDays}j` : ""}): ${rows.length} lignes`);
  return rows;
}

/**
 * Vues par page sur une fenêtre ciblée, restreinte à une liste de chemins
 * (matching CONTAINS). Utilisé pour récupérer le pic annuel des articles
 * saisonniers flaggés sans réinterroger tout le corpus blog sur 365j.
 */
export async function pageViewsForPaths(windowDays, paths) {
  if (!paths.length) return [];
  const merged = await runReportPaged({
    dateRanges: [dateRange(windowDays)],
    dimensions: [{ name: "hostName" }, { name: "pagePath" }],
    metrics: [{ name: "screenPageViews" }],
    dimensionFilter: {
      orGroup: {
        expressions: paths.map((p) => ({
          filter: { fieldName: "pagePath", stringFilter: { matchType: "CONTAINS", value: p } },
        })),
      },
    },
    limit: 10000,
  });
  return rowsToObjects(merged);
}

/** Canaux d'acquisition par site (sessions + revenu), en dernier point de contact (last-click). */
export async function acquisitionByChannel(windowDays) {
  const report = await runReport({
    dateRanges: [dateRange(windowDays)],
    dimensions: [{ name: "hostName" }, { name: "sessionDefaultChannelGroup" }],
    metrics: [{ name: "sessions" }, { name: "totalRevenue" }, { name: "totalUsers" }],
    limit: 1000,
  });
  return rowsToObjects(report);
}

/**
 * Canaux d'acquisition par site, en premier point de contact (first-touch).
 * À comparer avec `acquisitionByChannel` (last-click) : un canal peut amener
 * le visiteur sans capter la conversion, qui arrive plus tard via un autre
 * canal (ex. direct après un retour depuis le blog).
 */
export async function acquisitionByFirstTouch(windowDays) {
  const report = await runReport({
    dateRanges: [dateRange(windowDays)],
    dimensions: [{ name: "hostName" }, { name: "firstUserDefaultChannelGroup" }],
    metrics: [{ name: "sessions" }, { name: "totalRevenue" }, { name: "totalUsers" }],
    limit: 1000,
  });
  return rowsToObjects(report);
}

/** Comparaison période courante vs période précédente (sessions/revenu par site). */
export async function periodComparison(windowDays) {
  const [current, previous] = await Promise.all([
    runReport({
      dateRanges: [dateRange(windowDays)],
      dimensions: [{ name: "hostName" }],
      metrics: [{ name: "sessions" }, { name: "totalRevenue" }],
      limit: 100,
    }),
    runReport({
      dateRanges: [dateRange(windowDays, windowDays)],
      dimensions: [{ name: "hostName" }],
      metrics: [{ name: "sessions" }, { name: "totalRevenue" }],
      limit: 100,
    }),
  ]);
  return { current: rowsToObjects(current), previous: rowsToObjects(previous) };
}

/**
 * Trafic référé par les LLM (ChatGPT, Perplexity, Claude, Gemini, Copilot…),
 * ventilé par host + landing page.
 */
export async function llmTraffic(windowDays) {
  const report = await runReport({
    dateRanges: [dateRange(windowDays)],
    dimensions: [{ name: "hostName" }, { name: "landingPage" }, { name: "sessionSource" }],
    metrics: [{ name: "sessions" }],
    dimensionFilter: {
      orGroup: {
        expressions: llmSources.map((source) => ({
          filter: {
            fieldName: "sessionSource",
            stringFilter: { matchType: "CONTAINS", value: source },
          },
        })),
      },
    },
    limit: 5000,
  });
  return rowsToObjects(report);
}

/** Top landing pages par site (pour le maillage et l'arbitrage). */
export async function topLandingPages(windowDays, limit = 200) {
  const report = await runReport({
    dateRanges: [dateRange(windowDays)],
    dimensions: [{ name: "hostName" }, { name: "landingPage" }],
    metrics: [{ name: "sessions" }, { name: "totalRevenue" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit,
  });
  return rowsToObjects(report);
}
