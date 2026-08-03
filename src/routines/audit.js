import { env, checkEnv } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { buildAuditDataset } from "../lib/pipeline.js";
import { writeReviewPack } from "../lib/review-pack.js";
import { sendRunReport, sendFailureAlert } from "../lib/slack.js";
import { appendHistory, saveRunArtifact } from "../lib/state.js";

/**
 * AUDIT — collecte, classifie, applique les garde-fous et rapporte.
 * Ne supprime JAMAIS rien (c'est le rôle de purge). C'est la routine
 * à lancer pour voir ce que le pipeline ferait.
 */
export async function runAudit({ dryRunOverride = null } = {}) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const problems = checkEnv(["google", "slack", "shopify"]);
  if (problems.length) throw new Error(`Credentials manquants:\n- ${problems.join("\n- ")}`);

  try {
    const dataset = await buildAuditDataset();

    // En audit, les "deletions" sont le plan approuvé, jamais exécuté.
    const plannedDeletions = dataset.approved.map((a) => ({
      ...a, backupFile: "(sera créé à la purge)", redirectTo: "(défini à la purge)", executed: false,
    }));

    const reviewPackPath = writeReviewPack(dataset, null);
    saveRunArtifact("audit", {
      totals: dataset.totals, approved: dataset.approved.map(slim),
      rejected: dataset.rejected.map((a) => ({ ...slim(a), rejectReasons: a.rejectReasons })),
    });
    appendHistory("audit", { totals: dataset.totals });

    await sendRunReport({
      routine: "Audit (plan de suppression)",
      dryRun: true,
      windowDays: dataset.windowDays,
      startedAt,
      durationSeconds: Math.round((Date.now() - t0) / 1000),
      totals: dataset.totals,
      deletions: plannedDeletions,
      rejections: dataset.rejected,
      diamonds: dataset.diamonds,
      refreshCandidates: dataset.refreshCandidates,
      reviewPackPath,
    });

    logger.info("Audit terminé");
    return dataset;
  } catch (err) {
    await sendFailureAlert("audit", err);
    throw err;
  }
}

function slim(a) {
  return { slug: a.slug, site: a.siteKey, views: a.views, users: a.users, tier: a.tier, cluster: a.cluster };
}
