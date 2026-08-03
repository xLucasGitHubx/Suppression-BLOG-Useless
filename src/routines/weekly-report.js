import { env, checkEnv } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import * as ga4 from "../lib/ga4.js";
import * as gsc from "../lib/gsc.js";
import { editorialSites, sitesConfig, thresholds } from "../lib/classify.js";
import { buildAuditDataset, executeDeletions } from "../lib/pipeline.js";
import { runAnalysisAgents } from "../lib/claude.js";
import { writeReviewPack } from "../lib/review-pack.js";
import { sendRunReport, sendFailureAlert } from "../lib/slack.js";
import { appendHistory, saveRunArtifact } from "../lib/state.js";

/**
 * WEEKLY REPORT — la grosse routine du lundi matin.
 * 1. Collecte complète : GA4 (canaux, comparaison, landing pages, LLM) + GSC (queries, comparaison) + audit blog
 * 2. Suppression auto des articles morts (garde-fous + plafond)
 * 3. Analyse par 4 agents Claude + synthèse Master
 * 4. Review pack pour les actions humaines
 * 5. Rapport Slack complet
 */
export async function runWeeklyReport({ confirm = false } = {}) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const problems = checkEnv(["google", "anthropic", "slack", "shopify"]);
  if (problems.length) throw new Error(`Credentials manquants:\n- ${problems.join("\n- ")}`);

  const dryRun = env.dryRun || !confirm;
  const windowDays = 30; // fenêtre business du weekly ; l'audit blog garde sa fenêtre 90j

  try {
    // --- Collecte business + audit blog en parallèle ---
    const [acquisition, acquisitionFirstTouch, comparison, landingPages, dataset, gscBySite] = await Promise.all([
      ga4.acquisitionByChannel(windowDays),
      ga4.acquisitionByFirstTouch(windowDays),
      ga4.periodComparison(windowDays),
      ga4.topLandingPages(windowDays),
      buildAuditDataset(),
      collectGscAllSites(),
    ]);

    // --- Suppression auto (la partie full-auto du pipeline) ---
    const { deletions, errors } = await executeDeletions(dataset.approved, { dryRun });

    // --- Agents Claude ---
    const analyses = await runAnalysisAgents({
      acquisition,
      acquisitionFirstTouch,
      comparison,
      landingPages: landingPages.slice(0, 100),
      gsc: gscBySite,
      llm: dataset.llmRows,
      clusterStats: dataset.clusterStats,
      tierDistribution: dataset.tierDistribution,
      diamonds: dataset.diamonds,
      refreshCandidates: dataset.refreshCandidates,
      deletionPlan: dataset.approved.map((a) => ({ slug: a.slug, site: a.siteKey, views: a.views, cluster: a.cluster })),
      deletionsExecuted: deletions.map((d) => ({ slug: d.slug, site: d.siteKey, executed: d.executed })),
    });

    // --- Review pack + persistance ---
    const reviewPackPath = writeReviewPack(dataset, analyses);
    saveRunArtifact("weekly", { totals: dataset.totals, analyses, deletions: deletions.length, errors });
    appendHistory("weekly", {
      globalScore: analyses.master.globalScore,
      deleted: deletions.filter((d) => d.executed).length,
      totals: dataset.totals,
    });

    // --- Rapport Slack ---
    await sendRunReport({
      routine: "Rapport hebdomadaire SEO + IA",
      dryRun,
      windowDays: dataset.windowDays,
      startedAt,
      durationSeconds: Math.round((Date.now() - t0) / 1000),
      totals: dataset.totals,
      deletions,
      rejections: dataset.rejected,
      diamonds: dataset.diamonds,
      refreshCandidates: dataset.refreshCandidates,
      analyses,
      reviewPackPath,
      errors,
    });

    logger.info("Weekly report terminé");
    return { dataset, analyses, deletions };
  } catch (err) {
    await sendFailureAlert("weekly-report", err);
    throw err;
  }
}

async function collectGscAllSites() {
  const out = {};
  for (const site of sitesConfig.sites) {
    const [queries, comparison] = await Promise.all([
      gsc.topQueries(site.gscSiteUrl, 30, 100),
      gsc.queryComparison(site.gscSiteUrl),
    ]);
    out[site.key] = { type: site.type, topQueries: queries.slice(0, 50), ...comparison };
  }
  return out;
}
