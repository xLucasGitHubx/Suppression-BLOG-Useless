import { loadConfig } from "./env.js";
import { thresholds } from "./classify.js";

const protectedSlugs = new Set(loadConfig("protected-slugs").protected.map((s) => s.toLowerCase()));

/**
 * Garde-fous de suppression. Un article n'est supprimable QUE si tous les
 * checks passent. Retourne { ok, reasons } — reasons liste tout ce qui bloque,
 * pour que le rapport Slack soit auditable.
 *
 * Données attendues sur `article` :
 *  - views, users, engagementSeconds (GA4, 90j)
 *  - gsc: { clicks, impressions } (Search Console, 90j) — null si introuvable
 *  - llmSessions (sessions référées par des IA, 90j)
 *  - shopify: { id, published_at, created_at } — null si pas matché côté Shopify
 *  - live: bool (la page répond encore en HTTP < 400)
 *  - seasonal: bool, viewsYear: vues sur 365j (uniquement si seasonal, sinon undefined)
 *  - trend: "croissance" | "stable" | "déclin", viewsPrevious (fenêtre précédente)
 */
export function checkDeletable(article) {
  const d = thresholds.deletion;
  const reasons = [];

  if (protectedSlugs.has(article.slug)) reasons.push("slug protégé (protected-slugs.json)");

  if (article.views > d.maxViews90d) reasons.push(`vues ${article.views} > seuil ${d.maxViews90d}`);
  if (article.users > d.maxUsers90d) reasons.push(`users ${article.users} > seuil ${d.maxUsers90d}`);
  if (article.engagementSeconds > d.maxEngagementSeconds)
    reasons.push(`engagement ${article.engagementSeconds}s > seuil ${d.maxEngagementSeconds}s`);

  // GSC : ne jamais tuer une page qui reçoit des clics ou des impressions notables.
  // GSC ne renvoie une ligne que si la page a eu ≥1 impression sur la fenêtre : une absence
  // de ligne peut donc être interprétée comme un 0 confirmé — sous 3 filets de sécurité.
  if (!article.gsc) {
    if (!d.treatMissingGscAsZero) {
      reasons.push("données GSC indisponibles pour cette page — suppression bloquée par prudence");
    } else if (article.gscSiteHealthy === false) {
      reasons.push(
        `GSC ne renvoie que ${article.gscSiteRowCount ?? 0} lignes pour ce site (< ${d.minGscRowsForInference}) — données jugées non fiables, suppression bloquée`
      );
    } else if (article.gscSlugCollision === true) {
      reasons.push("slug présent en GSC sous un autre site — attribution ambiguë, suppression bloquée");
    }
    // sinon : absence de ligne GSC = 0 clic / 0 impression confirmés, pas de blocage.
  } else {
    if (article.gsc.clicks > d.maxGscClicks90d) reasons.push(`GSC clics ${article.gsc.clicks} > ${d.maxGscClicks90d}`);
    if (article.gsc.impressions > d.maxGscImpressions90d)
      reasons.push(`GSC impressions ${article.gsc.impressions} > ${d.maxGscImpressions90d}`);
  }

  if (article.llmSessions > d.maxLlmSessions90d)
    reasons.push(`${article.llmSessions} sessions IA vers cette page — visibilité LLM à préserver`);

  // Saisonnalité : la fenêtre glissante (90j) peut tomber hors saison (ex. Noël en juillet).
  // On vérifie le pic annuel (365j) avant de conclure qu'un article saisonnier est mort.
  if (d.blockSeasonalDeletions && article.seasonal && (article.viewsYear ?? 0) > d.maxSeasonalViews365d) {
    reasons.push(
      `article saisonnier — ${article.viewsYear} vues sur 365j (> seuil ${d.maxSeasonalViews365d}), suppression bloquée hors saison`
    );
  }

  // Tendance : ne pas supprimer un article en pleine croissance (démarrage) sous prétexte
  // qu'il a peu de vues en absolu — il n'a simplement pas eu le temps de monter.
  // Tous les articles flaggés ont ≤ maxViews90d vues : un simple ratio (0→1, 1→2) n'est que
  // du bruit. On exige donc aussi un gain ABSOLU minimum pour parler de croissance réelle.
  if (d.blockGrowingArticles && article.trend === "croissance") {
    const delta = article.views - (article.viewsPrevious ?? 0);
    if (delta >= d.minTrendDeltaViews) {
      reasons.push(
        `article en croissance nette (${article.viewsPrevious} → ${article.views} vues, +${delta}) — suppression bloquée`
      );
    }
  }

  // Âge : ne pas tuer un article récent qui n'a pas eu le temps de ranker.
  if (!article.shopify) {
    reasons.push("article non matché dans Shopify — suppression impossible");
  } else {
    const publishedAt = article.shopify.published_at || article.shopify.created_at;
    const ageDays = publishedAt ? (Date.now() - new Date(publishedAt).getTime()) / 86400000 : 0;
    if (ageDays < d.minArticleAgeDays)
      reasons.push(`article publié il y a ${Math.round(ageDays)}j < minimum ${d.minArticleAgeDays}j`);
  }

  if (article.live === false) reasons.push("page déjà en 404/410 — rien à supprimer");

  return { ok: reasons.length === 0, reasons };
}

/**
 * Applique les garde-fous à la liste des articles flaggés et le plafond par run.
 * Retourne { approved, rejected } — rejected garde les raisons pour le rapport.
 *
 * Plafonds : `maxPerRun` (global) et `maxInferredZeroDeletionsPerRun` (sous-plafond
 * sur les suppressions basées sur un zéro GSC inféré). Une valeur ≤ 0 (ou non finie)
 * signifie « aucun plafond » : tous les articles éligibles non protégés sont supprimés.
 */
export function applyGuardrails(flaggedArticles, maxPerRun) {
  const d = thresholds.deletion;
  const approved = [];
  const rejected = [];
  const globalCap = maxPerRun > 0 ? maxPerRun : Infinity;
  const inferredCap = d.maxInferredZeroDeletionsPerRun > 0 ? d.maxInferredZeroDeletionsPerRun : Infinity;
  let inferredZeroApproved = 0;
  for (const article of flaggedArticles) {
    const { ok, reasons } = checkDeletable(article);
    if (!ok) {
      rejected.push({ ...article, rejectReasons: reasons });
      continue;
    }
    const isInferredZero = article.gscSource === "inferred-zero";
    if (isInferredZero && inferredZeroApproved >= inferredCap) {
      rejected.push({
        ...article,
        rejectReasons: [`sous-plafond de ${inferredCap} suppressions/run sur données GSC inférées atteint — reporté au prochain run`],
      });
      continue;
    }
    if (approved.length < globalCap) {
      approved.push(article);
      if (isInferredZero) inferredZeroApproved++;
    } else {
      rejected.push({ ...article, rejectReasons: [`plafond ${globalCap} suppressions/run atteint — reporté au prochain run`] });
    }
  }
  return { approved, rejected };
}
