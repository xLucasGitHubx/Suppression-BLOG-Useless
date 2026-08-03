import Anthropic from "@anthropic-ai/sdk";
import { env } from "./env.js";
import { logger } from "./logger.js";

const MODEL = "claude-sonnet-4-6";

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: env.anthropicKey });
  return client;
}

const AGENT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer", description: "Score /100 de la dimension analysée" },
    headline: { type: "string", description: "Le constat principal en une phrase" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
          severity: { type: "string", enum: ["red_flag", "warning", "green_light", "info"] },
        },
        required: ["title", "detail", "severity"],
        additionalProperties: false,
      },
    },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action: { type: "string", description: "Quoi faire, concrètement" },
          where: { type: "string", description: "Pages/sites/clusters concernés" },
          expectedImpact: { type: "string" },
          effort: { type: "string", enum: ["faible", "moyen", "élevé"] },
          owner: { type: "string", description: "Qui doit le faire (rôle)" },
        },
        required: ["action", "where", "expectedImpact", "effort", "owner"],
        additionalProperties: false,
      },
    },
  },
  required: ["score", "headline", "findings", "recommendations"],
  additionalProperties: false,
};

const MASTER_SCHEMA = {
  type: "object",
  properties: {
    globalScore: { type: "integer" },
    synthesis: { type: "string", description: "Synthèse stratégique, 5-8 phrases, actionnable lundi matin" },
    weeklyActions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          priority: { type: "integer" },
          action: { type: "string" },
          where: { type: "string" },
          impact: { type: "string" },
          effort: { type: "string", enum: ["faible", "moyen", "élevé"] },
          owner: { type: "string" },
        },
        required: ["priority", "action", "where", "impact", "effort", "owner"],
        additionalProperties: false,
      },
    },
    doNotDo: { type: "array", items: { type: "string" } },
    toTest: {
      type: "array",
      items: {
        type: "object",
        properties: {
          idea: { type: "string" },
          successMetric: { type: "string" },
        },
        required: ["idea", "successMetric"],
        additionalProperties: false,
      },
    },
    kpisToTrack: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kpi: { type: "string" },
          current: { type: "string" },
          target: { type: "string" },
        },
        required: ["kpi", "current", "target"],
        additionalProperties: false,
      },
    },
  },
  required: ["globalScore", "synthesis", "weeklyActions", "doNotDo", "toTest", "kpisToTrack"],
  additionalProperties: false,
};

async function runAgent({ name, system, data, schema, maxTokens = 16000 }) {
  logger.info(`Agent Claude "${name}" en cours…`);
  const stream = getClient().messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    output_config: { format: { type: "json_schema", schema } },
    messages: [
      {
        role: "user",
        content: `Voici les données à analyser (JSON) :\n\n${JSON.stringify(data)}`,
      },
    ],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") {
    throw new Error(`Agent ${name}: refus du modèle`);
  }
  const text = message.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error(`Agent ${name}: réponse vide`);
  const parsed = JSON.parse(text);
  logger.info(`Agent "${name}" terminé (score ${parsed.score ?? parsed.globalScore ?? "?"})`);
  return parsed;
}

const COMMON_CONTEXT = `Tu analyses les données SEO/analytics du groupe Lovebox (objet connecté pour couples/familles à distance).
6 sites : EN/FR/EU (éditoriaux Shopify avec blog /blogs/news/) et BUY/BOUTIQUE/STORE (one-pages d'achat).
Le business est porté par EN. Clusters forts : long-distance, love-messages, apology, goodnight.
Sois factuel, chiffré, et actionnable. Réponds en français. Chaque recommandation doit nommer des pages/slugs précis quand les données le permettent.`;

export async function runAnalysisAgents(datasets) {
  const [analytics, seo, content, aiVisibility] = await Promise.all([
    runAgent({
      name: "Analytics (GA4)",
      system: `${COMMON_CONTEXT}\nTon rôle : analyser le trafic, le revenu, les canaux d'acquisition et l'évolution vs période précédente. Calcule €/session par site, identifie les concentrations de trafic et les anomalies.
IMPORTANT — attribution : "acquisitionByChannelLastTouch" (dernier clic) et "acquisitionByChannelFirstTouch" (premier point de contact) sont fournis. Compare systématiquement les deux avant toute conclusion sur la rentabilité d'un canal. Un canal comme le blog (souvent en first-touch, découverte) peut sembler non-rentable en last-click alors qu'il amorce des parcours qui convertissent plus tard via un autre canal (ex. direct). Ne déclare JAMAIS un canal "non-rentable" ou "à couper" sur la seule base du last-click : signale explicitement l'écart first-touch vs last-touch quand il existe, et nuance la conclusion en conséquence.`,
      data: {
        acquisitionByChannelLastTouch: datasets.acquisition,
        acquisitionByChannelFirstTouch: datasets.acquisitionFirstTouch,
        periodComparison: datasets.comparison,
        topLandingPages: datasets.landingPages,
      },
      schema: AGENT_OUTPUT_SCHEMA,
    }),
    runAgent({
      name: "SEO (Search Console)",
      system: `${COMMON_CONTEXT}\nTon rôle : analyser les performances Search Console par site — CTR, positions, requêtes gagnantes/perdantes, cannibalisation potentielle entre pages/sites.`,
      data: { gscBySite: datasets.gsc },
      schema: AGENT_OUTPUT_SCHEMA,
    }),
    runAgent({
      name: "Content Audit (blog)",
      system: `${COMMON_CONTEXT}\nTon rôle : auditer le blog éditorial uniquement. Analyse les tiers de performance, le dead rate par cluster, les diamants à pousser (fort engagement/faible visibilité), les pages à refresh (fort trafic/faible engagement), et la pertinence des suppressions prévues.`,
      data: {
        clusterStats: datasets.clusterStats,
        tierDistribution: datasets.tierDistribution,
        diamonds: datasets.diamonds,
        refreshCandidates: datasets.refreshCandidates,
        deletionPlan: datasets.deletionPlan,
      },
      schema: AGENT_OUTPUT_SCHEMA,
    }),
    runAgent({
      name: "AI Visibility (LLM)",
      system: `${COMMON_CONTEXT}\nTon rôle : analyser le trafic référé par les IA (ChatGPT, Perplexity, Claude, Gemini, Copilot). Distingue trafic IA vers contenu éditorial vs pages d'achat (intention directe). Identifie les pages déjà recommandées par les IA et comment renforcer cette visibilité.`,
      data: { llmTraffic: datasets.llm },
      schema: AGENT_OUTPUT_SCHEMA,
    }),
  ]);

  const master = await runAgent({
    name: "Master (synthèse)",
    system: `${COMMON_CONTEXT}\nTon rôle : synthétiser les 4 analyses ci-dessous en brief stratégique pour le lundi matin. Priorise sans diluer : max 5 actions semaine, chacune avec impact attendu chiffré quand possible. Le globalScore pondère les 4 scores reçus.`,
    data: {
      agentAnalytics: analytics,
      agentSEO: seo,
      agentContent: content,
      agentAIVisibility: aiVisibility,
      deletionsExecuted: datasets.deletionsExecuted || [],
    },
    schema: MASTER_SCHEMA,
    maxTokens: 20000,
  });

  return { analytics, seo, content, aiVisibility, master };
}
