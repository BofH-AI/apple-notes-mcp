import { appendFileSync } from "fs";
import { join } from "path";

const LOG_FILE = join("C:\\users\\matt\\applenotespwa", "debug.log");

export function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stderr.write(line);
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // ignore write errors
  }
}

export function logError(msg: string, err: unknown): void {
  const detail = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
  log(`ERROR ${msg}: ${detail}`);
}
