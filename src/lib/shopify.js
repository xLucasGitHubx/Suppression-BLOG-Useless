import fs from "node:fs";
import path from "node:path";
import { env, paths } from "./env.js";
import { logger } from "./logger.js";

const API_VERSION = "2024-10";

function store(siteKey) {
  const s = env.shopify[siteKey];
  if (!s?.domain || !s?.token) throw new Error(`Credentials Shopify manquants pour ${siteKey}`);
  return s;
}

async function shopifyFetch(siteKey, endpoint, options = {}) {
  const { domain, token } = store(siteKey);
  const url = `https://${domain}/admin/api/${API_VERSION}/${endpoint}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, {
      ...options,
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get("Retry-After") || 2) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Shopify ${siteKey} ${options.method || "GET"} ${endpoint} → ${res.status}: ${body.slice(0, 300)}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }
  throw new Error(`Shopify ${siteKey} ${endpoint}: rate limit persistant`);
}

/** Liste paginée de tous les articles d'un blog (handle → blog_id résolu). */
export async function listArticles(siteKey, blogHandle) {
  const blogs = await shopifyFetch(siteKey, "blogs.json?limit=250");
  const blog = blogs.blogs.find((b) => b.handle === blogHandle);
  if (!blog) throw new Error(`Blog "${blogHandle}" introuvable sur ${siteKey}`);

  const articles = [];
  let pageInfo = null;
  do {
    const qs = pageInfo ? `limit=250&page_info=${pageInfo}` : "limit=250";
    const { domain, token } = store(siteKey);
    const res = await fetch(
      `https://${domain}/admin/api/${API_VERSION}/blogs/${blog.id}/articles.json?${qs}`,
      { headers: { "X-Shopify-Access-Token": token } }
    );
    if (!res.ok) throw new Error(`Shopify ${siteKey} listArticles → ${res.status}`);
    const data = await res.json();
    articles.push(...data.articles);
    const link = res.headers.get("link") || "";
    const next = link.match(/<[^>]*page_info=([^>&]+)[^>]*>;\s*rel="next"/);
    pageInfo = next ? next[1] : null;
  } while (pageInfo);

  return { blogId: blog.id, articles };
}

/** Récupère l'article complet (body_html, image, author, summary_html…) avant backup/suppression. */
export async function getArticle(siteKey, blogId, articleId) {
  const data = await shopifyFetch(siteKey, `blogs/${blogId}/articles/${articleId}.json`);
  return data.article;
}

/** Backup JSON complet d'un article (titre, body_html, meta, tags…) avant toute suppression. */
export function backupArticle(siteKey, article) {
  const dir = path.join(paths.backups, siteKey);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${article.handle}_${article.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ backedUpAt: new Date().toISOString(), siteKey, article }, null, 2));
  return file;
}

/** Supprime un article. Le backup DOIT avoir été fait avant (vérifié par le caller). */
export async function deleteArticle(siteKey, blogId, articleId) {
  await shopifyFetch(siteKey, `blogs/${blogId}/articles/${articleId}.json`, { method: "DELETE" });
  logger.info(`Shopify ${siteKey}: article ${articleId} supprimé`);
}

/** Crée une redirection 301 de l'ancienne URL vers la cible. */
export async function createRedirect(siteKey, fromPath, toPath) {
  try {
    const data = await shopifyFetch(siteKey, "redirects.json", {
      method: "POST",
      body: JSON.stringify({ redirect: { path: fromPath, target: toPath } }),
    });
    return data.redirect;
  } catch (err) {
    // 422 = redirect déjà existant : non bloquant
    if (err.message.includes("422")) {
      logger.warn(`Redirect déjà existant pour ${fromPath} (${siteKey})`);
      return null;
    }
    throw err;
  }
}

/** Vérifie qu'une URL publique répond (filtre les déjà-404). */
export async function isLive(url) {
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "manual" });
    return res.status < 400;
  } catch {
    return false;
  }
}
