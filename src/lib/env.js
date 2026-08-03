import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const paths = {
  root: ROOT,
  config: path.join(ROOT, "config"),
  data: path.join(ROOT, "data"),
  backups: path.join(ROOT, "data", "backups"),
  history: path.join(ROOT, "data", "history"),
  review: path.join(ROOT, "review"),
};

for (const dir of [paths.data, paths.backups, paths.history, paths.review]) {
  fs.mkdirSync(dir, { recursive: true });
}

export function loadConfig(name) {
  return JSON.parse(fs.readFileSync(path.join(paths.config, `${name}.json`), "utf8"));
}

export const env = {
  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  googleRedirectUri: "http://localhost:3000/oauth2callback",
  ga4PropertyId: process.env.GA4_PROPERTY_ID || "",
  slackToken: process.env.SLACK_BOT_TOKEN || "",
  slackChannel: process.env.SLACK_CHANNEL_ID || "",
  dryRun: (process.env.DRY_RUN ?? "true").toLowerCase() !== "false",
  // ≤ 0 (ou "0") => aucun plafond : tous les articles éligibles non protégés sont supprimés.
  maxDeletionsPerRun: (() => {
    const n = Number(process.env.MAX_DELETIONS_PER_RUN ?? 15);
    return Number.isFinite(n) && n > 0 ? n : Infinity;
  })(),
  shopify: {
    EN: { domain: process.env.SHOPIFY_STORE_EN_DOMAIN || "", token: process.env.SHOPIFY_STORE_EN_TOKEN || "" },
    FR: { domain: process.env.SHOPIFY_STORE_FR_DOMAIN || "", token: process.env.SHOPIFY_STORE_FR_TOKEN || "" },
    EU: { domain: process.env.SHOPIFY_STORE_EU_DOMAIN || "", token: process.env.SHOPIFY_STORE_EU_TOKEN || "" },
  },
};

/**
 * Vérifie les credentials. Retourne la liste des problèmes (vide = tout bon).
 * `scope` permet de ne vérifier que ce dont une routine a besoin.
 */
export function checkEnv(scope = ["google", "anthropic", "slack", "shopify"]) {
  const problems = [];
  if (scope.includes("google")) {
    if (!env.googleClientId) problems.push("GOOGLE_CLIENT_ID manquant");
    if (!env.googleClientSecret) problems.push("GOOGLE_CLIENT_SECRET manquant");
    if (!env.ga4PropertyId) problems.push("GA4_PROPERTY_ID manquant");
    const tokenPath = path.join(paths.data, "google-token.json");
    if (!fs.existsSync(tokenPath)) problems.push("Token Google absent — lance : npm run auth-google");
  }
  if (scope.includes("anthropic") && !env.anthropicKey) problems.push("ANTHROPIC_API_KEY manquant");
  if (scope.includes("slack")) {
    if (!env.slackToken) problems.push("SLACK_BOT_TOKEN manquant");
    if (!env.slackChannel) problems.push("SLACK_CHANNEL_ID manquant");
  }
  if (scope.includes("shopify")) {
    for (const [key, s] of Object.entries(env.shopify)) {
      if (!s.domain || !s.token) problems.push(`Shopify ${key}: domaine ou token manquant`);
    }
  }
  return problems;
}
