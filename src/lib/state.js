import fs from "node:fs";
import path from "node:path";
import { paths } from "./env.js";

/**
 * Historique des runs en JSONL (un fichier par routine).
 * Sert au rapport Slack (comparaison run précédent) et à l'audit trail.
 */
export function appendHistory(routine, record) {
  const file = path.join(paths.history, `${routine}.jsonl`);
  fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
}

export function lastHistory(routine) {
  const file = path.join(paths.history, `${routine}.jsonl`);
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  if (!lines.length) return null;
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

/** Sauvegarde JSON complète d'un artefact de run (datasets, analyses…). */
export function saveRunArtifact(name, data) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(paths.history, `${stamp}_${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}
