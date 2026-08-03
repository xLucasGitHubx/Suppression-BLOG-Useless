import { env, checkEnv } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { buildAuditDataset, executeDeletions } from "../lib/pipeline.js";
import { writeReviewPack } from "../lib/review-pack.js";
import { sendRunReport, sendFailureAlert } from "../lib/slack.js";
import { appendHistory, saveRunArtifact } from "../lib/state.js";

/**
 * PURGE — la seule routine qui supprime réellement.
 * Double sécurité : DRY_RUN dans .env ET flag --confirm obligatoire.
 * Chaque suppression = backup JSON complet → DELETE Shopify → redirect 301.
 */
export async function runPurge({ confirm = false } = {}) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const problems = checkEnv(["google", "slack", "shopify"]);
  if (problems.length) throw new Error(`Credentials manquants:\n- ${problems.join("\n- ")}`);

  const dryRun = env.dryRun || !confirm;
  if (env.dryRun) logger.warn("DRY_RUN=true dans .env — simulation uniquement");
  else if (!confirm) logger.warn("Flag --confirm absent — simulation uniquement");

  try {
    const dataset = await buildAuditDataset();
    const { deletions, errors } = await executeDeletions(dataset.approved, { dryRun });

    const reviewPackPath = writeReviewPack(dataset, null);
    saveRunArtifact("purge", {
      dryRun,
      deletions: deletions.map((d) => ({
        slug: d.slug, site: d.siteKey, views: d.views,
        backupFile: d.backupFile, redirectTo: d.redirectTo, executed: d.executed,
      })),
      errors,
    });
    appendHistory("purge", { dryRun, deleted: deletions.filter((d) => d.executed).length, errors: errors.length });

    await sendRunReport({
      routine: "Purge (suppression articles morts)",
      dryRun,
      windowDays: dataset.windowDays,
      startedAt,
      durationSeconds: Math.round((Date.now() - t0) / 1000),
      totals: dataset.totals,
      deletions,
      rejections: dataset.rejected,
      diamonds: dataset.diamonds,
      refreshCandidates: dataset.refreshCandidates,
      reviewPackPath,
      errors,
    });

    logger.info(`Purge terminée — ${deletions.length} ${dryRun ? "simulées" : "exécutées"}, ${errors.length} erreurs`);
    return { deletions, errors };
  } catch (err) {
    await sendFailureAlert("purge", err);
    throw err;
  }
}
