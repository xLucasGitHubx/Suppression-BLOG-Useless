import fs from "node:fs";
import path from "node:path";
import { paths } from "./env.js";

/**
 * Génère le "review pack" : tout ce qui demande une décision/action HUMAINE
 * (refresh, maillage, fusion, noindex, arbitrages) — par opposition aux
 * suppressions qui sont full-auto. Format markdown lisible + JSON machine,
 * pensé pour être ouvert dans Claude Code et traité en interactif.
 */
export function writeReviewPack(dataset, analyses) {
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = path.join(paths.review, stamp);
  fs.mkdirSync(dir, { recursive: true });

  const pack = {
    generatedAt: new Date().toISOString(),
    windowDays: dataset.windowDays,
    humanActions: {
      refresh: dataset.refreshCandidates.map((a) => ({
        slug: a.slug, site: a.siteKey, url: a.url,
        views: a.views, engagementSeconds: a.engagementSeconds, cluster: a.cluster,
        why: "Fort trafic mais engagement quasi nul — refaire intro/H1/CTA/FAQ",
      })),
      diamonds: dataset.diamonds.map((a) => ({
        slug: a.slug, site: a.siteKey, url: a.url,
        views: a.views, engagementSeconds: a.engagementSeconds, cluster: a.cluster,
        why: "Fort engagement, faible visibilité — ajouter du maillage interne depuis les performers",
      })),
      blockedDeletions: dataset.rejected.map((a) => ({
        slug: a.slug, site: a.siteKey, url: a.url, views: a.views,
        gscSource: a.gscSource || "unavailable",
        blockedBy: a.rejectReasons,
        decision: "À trancher : noindex ? fusion ? attendre ? ajouter à protected-slugs.json ?",
      })),
      masterActions: analyses?.master?.weeklyActions || [],
      toTest: analyses?.master?.toTest || [],
    },
    context: {
      clusterStats: dataset.clusterStats,
      tierDistribution: dataset.tierDistribution,
      totals: dataset.totals,
    },
  };

  fs.writeFileSync(path.join(dir, "review-pack.json"), JSON.stringify(pack, null, 2));

  const md = [
    `# Review Pack Lovebox — ${stamp}`,
    ``,
    `> Suppressions d'articles = gérées en auto par le pipeline.`,
    `> **Tout ce qui suit demande une décision humaine.** Ouvre ce dossier dans Claude Code pour traiter chaque action en interactif.`,
    ``,
    `## ♻️ À refresh (${pack.humanActions.refresh.length})`,
    ...pack.humanActions.refresh.map((a) => `- [ ] **${a.slug}** (${a.site}) — ${a.views} vues / ${a.engagementSeconds}s — ${a.why}\n  ${a.url}`),
    ``,
    `## 💎 Diamants à pousser (${pack.humanActions.diamonds.length})`,
    ...pack.humanActions.diamonds.map((a) => `- [ ] **${a.slug}** (${a.site}) — ${a.engagementSeconds}s d'engagement / ${a.views} vues — ${a.why}\n  ${a.url}`),
    ``,
    `## 🛡️ Suppressions bloquées à arbitrer (${pack.humanActions.blockedDeletions.length})`,
    ...pack.humanActions.blockedDeletions.map((a) =>
      `- [ ] **${a.slug}** (${a.site}, ${a.views} vues, GSC: ${a.gscSource === "inferred-zero" ? "inféré 0" : a.gscSource === "api" ? "confirmé" : "indispo"}) — bloqué par : ${a.blockedBy.join(" · ")}\n  ${a.decision}`
    ),
    ``,
    `## ✅ Actions stratégiques de la semaine (agent Master)`,
    ...pack.humanActions.masterActions.map((a) => `- [ ] **P${a.priority} — ${a.action}**\n  Où : ${a.where} · Impact : ${a.impact} · Effort : ${a.effort} · Qui : ${a.owner}`),
    ``,
    `## 🧪 À tester`,
    ...pack.humanActions.toTest.map((t) => `- [ ] ${t.idea} → métrique : ${t.successMetric}`),
    ``,
  ].join("\n");

  fs.writeFileSync(path.join(dir, "REVIEW.md"), md);
  return dir;
}
