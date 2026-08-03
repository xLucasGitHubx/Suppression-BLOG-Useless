const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = LEVELS[process.env.LOG_LEVEL || "info"] ?? 20;

function log(level, msg, extra) {
  if (LEVELS[level] < minLevel) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${msg}`;
  const out = level === "error" ? console.error : console.log;
  if (extra !== undefined) out(line, typeof extra === "string" ? extra : JSON.stringify(extra));
  else out(line);
}

export const logger = {
  debug: (msg, extra) => log("debug", msg, extra),
  info: (msg, extra) => log("info", msg, extra),
  warn: (msg, extra) => log("warn", msg, extra),
  error: (msg, extra) => log("error", msg, extra),
};
