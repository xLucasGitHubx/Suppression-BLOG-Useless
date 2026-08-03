#!/usr/bin/env node
import { checkEnv, env } from "./lib/env.js";
import { logger } from "./lib/logger.js";

const [, , command, ...args] = process.argv;
const flags = new Set(args);

const HELP = `
Lovebox Blog Ops — routines

  npm run doctor          Vérifie les credentials (.env) sans rien lancer
  npm run audit           Audit complet → plan de suppression + rapport Slack (ne supprime rien)
  npm run purge           Simulation de purge (DRY_RUN ou sans --confirm)
  npm run purge:confirm   Purge RÉELLE : backup → suppression Shopify → 301 → rapport Slack
  npm run weekly          Rapport hebdo complet : collecte + suppression auto + agents Claude + Slack
                          (ajouter -- --confirm pour exécuter les suppressions en réel)

Garde-fous suppression (config/thresholds.json) :
  vues ≤ 10 ET users ≤ 10 ET 0 clic GSC ET < 50 impressions ET 0 session IA
  ET article ≥ 180 jours ET engagement ≤ 30s ET hors protected-slugs.json
  ET saisonnalité/tendance OK. Plafond : ${Number.isFinite(env.maxDeletionsPerRun) ? env.maxDeletionsPerRun : "illimité"} suppressions/run.
  Backup JSON + redirect 301 systématiques.
`;

async function main() {
  switch (command) {
    case "doctor": {
      const problems = checkEnv();
      if (!problems.length) {
        console.log("✅ Tous les credentials sont présents.");
        console.log(`   DRY_RUN=${env.dryRun} · MAX_DELETIONS_PER_RUN=${Number.isFinite(env.maxDeletionsPerRun) ? env.maxDeletionsPerRun : "illimité"}`);
      } else {
        console.log("❌ Problèmes détectés :");
        for (const p of problems) console.log(`   - ${p}`);
        process.exitCode = 1;
      }
      break;
    }
    case "audit": {
      const { runAudit } = await import("./routines/audit.js");
      await runAudit();
      break;
    }
    case "purge": {
      const { runPurge } = await import("./routines/purge.js");
      await runPurge({ confirm: flags.has("--confirm") });
      break;
    }
    case "weekly-report": {
      const { runWeeklyReport } = await import("./routines/weekly-report.js");
      await runWeeklyReport({ confirm: flags.has("--confirm") });
      break;
    }
    default:
      console.log(HELP);
      if (command) process.exitCode = 1;
  }
}

main().catch((err) => {
  logger.error(err.stack || err.message);
  process.exitCode = 1;
});
