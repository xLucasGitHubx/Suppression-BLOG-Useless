import { env } from "./env.js";
import { logger } from "./logger.js";

async function post(blocks, { threadTs = null, text = "Rapport Lovebox" } = {}) {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.slackToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: env.slackChannel,
      text,
      blocks,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      unfurl_links: false,
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack: ${data.error}`);
  return data.ts;
}

const MAX_TEXT = 2900;
const divider = { type: "divider" };
const section = (text) => ({ type: "section", text: { type: "mrkdwn", text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "…" : text } });
const header = (text) => ({ type: "header", text: { type: "plain_text", text: text.slice(0, 150), emoji: true } });
const context = (text) => ({ type: "context", elements: [{ type: "mrkdwn", text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "…" : text }] });

function chunkBlocks(blocks, size = 45) {
  const chunks = [];
  for (let i = 0; i < blocks.length; i += size) chunks.push(blocks.slice(i, i + size));
  return chunks;
}

/** Envoie un message principal + le reste en réponses de thread (limite 50 blocks/msg Slack). */
async function sendThreaded(mainBlocks, detailBlocks, summaryText) {
  const ts = await post(mainBlocks, { text: summaryText });
  for (const chunk of chunkBlocks(detailBlocks)) {
    if (chunk.length) await post(chunk, { threadTs: ts, text: "Détails" });
  }
  return ts;
}

function severityEmoji(sev) {
  return { red_flag: "🚨", warning: "⚠️", green_light: "✅", info: "ℹ️" }[sev] || "•";
}

function gscLabel(a) {
  if (a.gscSource === "inferred-zero") return "GSC: inféré 0";
  if (a.gscSource === "api") return "GSC: confirmé";
  return "GSC: indispo";
}

function fmtDeletion(d) {
  return `• \`${d.slug}\` (${d.siteKey}, ${d.views} vues, cluster ${d.cluster}, ${gscLabel(d)})\n   ↳ backup: \`${d.backupFile}\` · 301 → \`${d.redirectTo}\``;
}

function fmtRejection(r) {
  return `• \`${r.slug}\` (${r.siteKey}, ${r.views} vues) — ${r.rejectReasons.join(" · ")}`;
}

/**
 * Rapport complet d'un run (audit, purge ou weekly).
 * Contient TOUT : exécutions, refus avec raisons, analyses agents, synthèse, review pack.
 */
export async function sendRunReport(report) {
  const {
    routine, dryRun, windowDays, startedAt, durationSeconds,
    totals, deletions = [], rejections = [],
    diamonds = [], refreshCandidates = [],
    analyses = null, reviewPackPath = null, errors = [],
  } = report;

  const mode = dryRun ? "🧪 DRY-RUN (aucune suppression réelle)" : "🔴 LIVE";
  const main = [
    header(`Lovebox Blog Ops — ${routine}`),
    context(`${mode} · fenêtre ${windowDays}j · démarré ${startedAt} · durée ${durationSeconds}s`),
    divider,
  ];

  if (totals) {
    main.push(section(
      `*Vue d'ensemble*\n` +
      `• Articles analysés : *${totals.articlesAnalyzed}*\n` +
      `• Flaggés suppression (≤ seuil vues) : *${totals.flagged}*\n` +
      `• Approuvés par les garde-fous : *${totals.approved}*\n` +
      `• ${dryRun ? "Auraient été supprimés" : "Supprimés"} : *${deletions.length}*\n` +
      `• Bloqués par garde-fous : *${rejections.length}*\n` +
      (totals.deadRate != null ? `• Dead rate global : *${totals.deadRate}%*\n` : "")
    ));
  }

  if (analyses?.master) {
    const m = analyses.master;
    const scoreEmoji = m.globalScore >= 75 ? "🟢" : m.globalScore >= 50 ? "🟡" : "🔴";
    main.push(divider, section(`*${scoreEmoji} Score global : ${m.globalScore}/100*\n\n${m.synthesis}`));
    const scores = [
      ["Trafic", analyses.analytics?.score],
      ["SEO", analyses.seo?.score],
      ["Contenu", analyses.content?.score],
      ["Visib. IA", analyses.aiVisibility?.score],
    ].filter(([, s]) => s != null);
    if (scores.length) {
      main.push(context(scores.map(([label, s]) => `*${label}* ${s}/100`).join(" · ")));
    }
  }

  if (errors.length) {
    main.push(divider, section(`*⛔ Erreurs pendant le run*\n${errors.map((e) => `• ${e}`).join("\n")}`));
  }

  main.push(divider, context("Détails complets dans le thread 🧵"));

  // ---- Thread : tous les détails ----
  const details = [];

  if (deletions.length) {
    details.push(header(dryRun ? "🧪 Suppressions simulées" : "🗑️ Suppressions exécutées"));
    for (const batch of chunkLines(deletions.map(fmtDeletion), 8)) details.push(section(batch));
  }

  if (rejections.length) {
    details.push(header("🛡️ Bloqués par les garde-fous"));
    for (const batch of chunkLines(rejections.map(fmtRejection), 8)) details.push(section(batch));
  }

  if (diamonds.length) {
    details.push(header("💎 Diamants à pousser (action humaine)"));
    details.push(section(diamonds.map((d) =>
      `• \`${d.slug}\` (${d.siteKey}) — ${d.engagementSeconds}s d'engagement, ${d.views} vues, cluster ${d.cluster}`
    ).join("\n")));
  }

  if (refreshCandidates.length) {
    details.push(header("♻️ À refresh : trafic fort, engagement faible (action humaine)"));
    details.push(section(refreshCandidates.map((r) =>
      `• \`${r.slug}\` (${r.siteKey}) — ${r.views} vues mais ${r.engagementSeconds}s d'engagement`
    ).join("\n")));
  }

  if (analyses) {
    for (const [key, label] of [
      ["analytics", "📈 Agent Analytics"],
      ["seo", "🔍 Agent SEO"],
      ["content", "📝 Agent Contenu"],
      ["aiVisibility", "🤖 Agent Visibilité IA"],
    ]) {
      const a = analyses[key];
      if (!a) continue;
      details.push(header(`${label} — ${a.score}/100`));
      details.push(section(`_${a.headline}_`));
      if (a.findings?.length) {
        details.push(section(a.findings.map((f) => `${severityEmoji(f.severity)} *${f.title}* — ${f.detail}`).join("\n")));
      }
      if (a.recommendations?.length) {
        details.push(section("*Recommandations :*\n" + a.recommendations.map((r) =>
          `• ${r.action}\n   ↳ où : ${r.where} · impact : ${r.expectedImpact} · effort : ${r.effort} · qui : ${r.owner}`
        ).join("\n")));
      }
    }

    const m = analyses.master;
    if (m?.weeklyActions?.length) {
      details.push(header("✅ À FAIRE cette semaine"));
      details.push(section(m.weeklyActions
        .sort((a, b) => a.priority - b.priority)
        .map((a) => `*${a.priority}. ${a.action}*\n   ↳ où : ${a.where} · impact : ${a.impact} · effort : ${a.effort} · qui : ${a.owner}`)
        .join("\n\n")));
    }
    if (m?.doNotDo?.length) {
      details.push(header("⛔ À NE PAS FAIRE"));
      details.push(section(m.doNotDo.map((x) => `• ${x}`).join("\n")));
    }
    if (m?.toTest?.length) {
      details.push(header("🧪 À tester"));
      details.push(section(m.toTest.map((t) => `• ${t.idea}\n   ↳ métrique de succès : ${t.successMetric}`).join("\n")));
    }
    if (m?.kpisToTrack?.length) {
      details.push(header("📊 KPIs à suivre"));
      details.push(section(m.kpisToTrack.map((k) => `• ${k.kpi} : ${k.current} → *${k.target}*`).join("\n")));
    }
  }

  if (reviewPackPath) {
    details.push(divider, section(
      `📂 *Review pack généré* : \`${reviewPackPath}\`\n` +
      `Toutes les actions non-suppression (refresh, maillage, fusion, noindex) y sont détaillées. ` +
      `Ouvre-le dans Claude Code pour les traiter en interactif : \`claude "ouvre le dernier review pack et aide-moi à traiter les actions"\``
    ));
  }

  const ts = await sendThreaded(main, details, `Lovebox Blog Ops — ${routine} (${deletions.length} suppressions, ${rejections.length} bloqués)`);
  logger.info(`Rapport Slack envoyé (ts=${ts})`);
  return ts;
}

function chunkLines(lines, perBlock) {
  const out = [];
  for (let i = 0; i < lines.length; i += perBlock) out.push(lines.slice(i, i + perBlock).join("\n"));
  return out;
}

/** Notification d'échec d'un run (avec stack trace courte). */
export async function sendFailureAlert(routine, error) {
  try {
    await post([
      header(`❌ Lovebox Blog Ops — ${routine} a échoué`),
      section(`\`\`\`${String(error.stack || error.message || error).slice(0, 2500)}\`\`\``),
      context(`${new Date().toISOString()} — vérifier les logs et relancer manuellement.`),
    ], { text: `Échec ${routine}` });
  } catch (slackErr) {
    logger.error(`Impossible d'envoyer l'alerte Slack: ${slackErr.message}`);
  }
}
