import { OAuth2Client } from "google-auth-library";
import fs from "node:fs";
import { env, paths } from "./env.js";
import path from "node:path";

const SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
];

const TOKEN_PATH = path.join(paths.data, "google-token.json");

let cachedClient = null;

export function getOAuth2Client() {
  return new OAuth2Client(env.googleClientId, env.googleClientSecret, env.googleRedirectUri);
}

export async function googleClient() {
  if (cachedClient) return cachedClient;

  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(
      "Token Google absent. Lance d'abord : npm run auth-google\n" +
      `(attendu : ${TOKEN_PATH})`
    );
  }

  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
  const client = getOAuth2Client();
  client.setCredentials(tokens);

  // Auto-refresh : persiste le nouveau token si rafraîchi
  client.on("tokens", (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
  });

  cachedClient = client;
  return cachedClient;
}

export async function googleRequest(url, body) {
  const client = await googleClient();
  const res = await client.request({
    url,
    method: body ? "POST" : "GET",
    data: body,
    retryConfig: { retry: 3 },
  });
  return res.data;
}

export { SCOPES, TOKEN_PATH };
