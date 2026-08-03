#!/usr/bin/env node
/**
 * Génère les tokens d'accès Shopify pour les 3 stores (EU, FR, EN) en séquence.
 * Usage : node scripts/shopify-get-token.js
 *
 * Prérequis dans .env :
 *   SHOPIFY_CLIENT_ID_EU, SHOPIFY_CLIENT_SECRET_EU, SHOPIFY_STORE_EU_DOMAIN
 *   SHOPIFY_CLIENT_ID_FR, SHOPIFY_CLIENT_SECRET_FR, SHOPIFY_STORE_FR_DOMAIN
 *   SHOPIFY_CLIENT_ID_EN, SHOPIFY_CLIENT_SECRET_EN, SHOPIFY_STORE_EN_DOMAIN
 */
import "dotenv/config";
import http from "node:http";
import { exec } from "node:child_process";

const STORES = [
  { key: "EU", envToken: "SHOPIFY_STORE_EU_TOKEN" },
  { key: "FR", envToken: "SHOPIFY_STORE_FR_TOKEN" },
  { key: "EN", envToken: "SHOPIFY_STORE_EN_TOKEN" },
];

async function getTokenForStore({ key, envToken }) {
  const clientId = process.env[`SHOPIFY_CLIENT_ID_${key}`];
  const clientSecret = process.env[`SHOPIFY_CLIENT_SECRET_${key}`];
  const domain = process.env[`SHOPIFY_STORE_${key}_DOMAIN`];

  if (!clientId || !clientSecret || !domain) {
    console.error(`❌ Variables manquantes pour ${key} : SHOPIFY_CLIENT_ID_${key}, SHOPIFY_CLIENT_SECRET_${key}, SHOPIFY_STORE_${key}_DOMAIN`);
    process.exit(1);
  }

  const redirectUri = "http://localhost:3001/callback";
  const scopes = "read_content,write_content";
  const authUrl = `https://${domain}/admin/oauth/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}`;

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Store ${key} (${domain})`);
  console.log(`${"─".repeat(50)}`);
  console.log("Ouverture du navigateur...");
  exec(`start "" "${authUrl}"`);

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url.startsWith("/callback")) return;

      const url = new URL(req.url, "http://localhost:3001");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.end(`<h2>Erreur : ${error}</h2><p>Ferme cette fenêtre.</p>`);
        server.close();
        reject(new Error(`Autorisation refusée pour ${key}: ${error}`));
        return;
      }

      try {
        const tokenRes = await fetch(`https://${domain}/admin/oauth/access_token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
        });

        const data = await tokenRes.json();

        if (!data.access_token) {
          res.end(`<h2>Erreur</h2><pre>${JSON.stringify(data, null, 2)}</pre>`);
          server.close();
          reject(new Error(`Pas de token pour ${key}: ${JSON.stringify(data)}`));
          return;
        }

        res.end(`<h2>✅ Token ${key} obtenu !</h2><p>Ferme cette fenêtre et reviens dans le terminal.</p>`);
        server.close();
        resolve({ key, token: data.access_token, envToken });
      } catch (err) {
        res.end(`<h2>Erreur : ${err.message}</h2>`);
        server.close();
        reject(err);
      }
    });

    server.listen(3001, () => {
      console.log("En attente du callback sur http://localhost:3001/callback ...");
    });
  });
}

async function main() {
  console.log("Génération des tokens Shopify pour les 3 stores.");
  console.log("Le navigateur va s'ouvrir une fois par store — autorise à chaque fois.\n");

  const results = [];

  for (const store of STORES) {
    try {
      const result = await getTokenForStore(store);
      console.log(`✅ ${result.key} : ${result.token}`);
      results.push(result);
    } catch (err) {
      console.error(`❌ ${store.key} échoué : ${err.message}`);
    }
  }

  console.log(`\n${"═".repeat(50)}`);
  console.log("Ajoute ces lignes dans ton .env :");
  console.log(`${"═".repeat(50)}`);
  for (const { key, token } of results) {
    console.log(`SHOPIFY_STORE_${key}_TOKEN=${token}`);
  }
}

main().catch((err) => {
  console.error("❌ Fatal :", err.message);
  process.exit(1);
});
