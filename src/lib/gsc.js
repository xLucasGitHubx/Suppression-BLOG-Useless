import { googleRequest } from "./google.js";
import { logger } from "./logger.js";

const API = "https://searchconsole.googleapis.com/webmasters/v3";

function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

async function query(siteUrl, body) {
  const url = `${API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  try {
    const data = await googleRequest(url, body);
    return data.rows || [];
  } catch (err) {
    logger.warn(`GSC indisponible pour ${siteUrl}: ${err.message}`);
    return [];
  }
}

/** Top requêtes du site sur la fenêtre. */
export async function topQueries(siteUrl, windowDays, limit = 250) {
  const rows = await query(siteUrl, {
    startDate: isoDaysAgo(windowDays),
    endDate: isoDaysAgo(1),
    dimensions: ["query"],
    rowLimit: limit,
  });
  return rows.map((r) => ({
    query: r.keys[0],
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
  }));
}

/** Métriques GSC par page (clés pour les garde-fous de suppression). */
export async function pageMetrics(siteUrl, windowDays, limit = 5000) {
  const rows = await query(siteUrl, {
    startDate: isoDaysAgo(windowDays),
    endDate: isoDaysAgo(1),
    dimensions: ["page"],
    rowLimit: limit,
  });
  return rows.map((r) => ({
    page: r.keys[0],
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
  }));
}

/** Comparaison J-60→J-31 vs J-30→J-1 : requêtes gagnantes / perdantes. */
export async function queryComparison(siteUrl, limit = 250) {
  const [prev, curr] = await Promise.all([
    query(siteUrl, { startDate: isoDaysAgo(60), endDate: isoDaysAgo(31), dimensions: ["query"], rowLimit: limit }),
    query(siteUrl, { startDate: isoDaysAgo(30), endDate: isoDaysAgo(1), dimensions: ["query"], rowLimit: limit }),
  ]);
  const prevMap = new Map(prev.map((r) => [r.keys[0], r]));
  const winners = [];
  const losers = [];
  for (const row of curr) {
    const q = row.keys[0];
    const before = prevMap.get(q);
    const delta = row.clicks - (before?.clicks || 0);
    const entry = { query: q, clicksNow: row.clicks, clicksBefore: before?.clicks || 0, delta };
    if (delta >= 3) winners.push(entry);
    else if (delta <= -3) losers.push(entry);
  }
  winners.sort((a, b) => b.delta - a.delta);
  losers.sort((a, b) => a.delta - b.delta);
  return { winners: winners.slice(0, 20), losers: losers.slice(0, 20) };
}
