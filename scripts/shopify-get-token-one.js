#!/usr/bin/env node
/**
 * Génère le token pour UN seul store.
 * Usage : node scripts/shopify-get-token-one.js FR
 */
import "dotenv/config";
import http from "node:http";
import { exec } from "node:child_process";

const key = (process.argv[2] || "").toUpperCase();
if (!["EU", "FR", "EN"].includes(key)) {
  console.error("Usage : node scripts/shopify-get-token-one.js <EU|FR|EN>");
  process.exit(1);
}

const clientId = process.env[`SHOPIFY_CLIENT_ID_${key}`];
const clientSecret = process.env[`SHOPIFY_CLIENT_SECRET_${key}`];
const domain = process.env[`SHOPIFY_STORE_${key}_DOMAIN`];

if (!clientId || !clientSecret || !domain) {
  console.error(`❌ Variables manquantes : SHOPIFY_CLIENT_ID_${key}, SHOPIFY_CLIENT_SECRET_${key}, SHOPIFY_STORE_${key}_DOMAIN`);
  process.exit(1);
}

console.log(`\nStore : ${key} (${domain})`);
console.log(`Client ID : ${clientId}`);

const redirectUri = "http://localhost:3001/callback";
const scopes = "read_content,write_content";
const authUrl = `https://${domain}/admin/oauth/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}`;

console.log("\nOuverture du navigateur...");
exec(`start "" "${authUrl}"`);

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith("/callback")) return;

  const url = new URL(req.url, "http://localhost:3001");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  console.log("\nCallback reçu :");
  console.log("  code :", code ? code.slice(0, 20) + "..." : "absent");
  console.log("  error :", error || "aucun");

  if (error) {
    res.end(`<h2>Erreur : ${error}</h2>`);
    server.close();
    process.exit(1);
  }

  const tokenUrl = `https://${domain}/admin/oauth/access_token`;
  const body = JSON.stringify({ client_id: clientId, client_secret: clientSecret, code });

  console.log("\nÉchange du code contre le token...");
  console.log("  URL :", tokenUrl);

  const tokenRes = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  const raw = await tokenRes.text();
  console.log("  Status :", tokenRes.status);
  console.log("  Réponse brute :", raw.slice(0, 300));

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    res.end(`<h2>Réponse non-JSON (status ${tokenRes.status})</h2><pre>${raw.slice(0, 500)}</pre>`);
    server.close();
    console.error("❌ Réponse non-JSON — voir ci-dessus");
    process.exit(1);
  }

  if (!data.access_token) {
    res.end(`<h2>Pas de token</h2><pre>${JSON.stringify(data, null, 2)}</pre>`);
    server.close();
    console.error("❌ Pas de access_token :", data);
    process.exit(1);
  }

  res.end(`<h2>✅ Token obtenu !</h2><p>Ferme cette fenêtre.</p>`);
  server.close();

  console.log(`\n✅ Token obtenu !`);
  console.log(`\nAjoute dans ton .env :`);
  console.log(`SHOPIFY_STORE_${key}_TOKEN=${data.access_token}`);
  process.exit(0);
});

server.listen(3001, () => {
  console.log("En attente du callback sur http://localhost:3001/callback ...");
});
