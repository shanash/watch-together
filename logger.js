import { appendFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, 'logs');

// Ensure logs directory exists
await mkdir(LOG_DIR, { recursive: true });

function getLogFile() {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(LOG_DIR, `${date}.log`);
}

function formatLine(level, category, message, data) {
  const ts = new Date().toISOString();
  const base = `[${ts}] [${level}] [${category}] ${message}`;
  if (data && Object.keys(data).length > 0) {
    return `${base} | ${JSON.stringify(data)}\n`;
  }
  return `${base}\n`;
}

async function write(level, category, message, data = {}) {
  const line = formatLine(level, category, message, data);
  // Also print to console
  if (level === 'ERROR') console.error(line.trimEnd());
  else if (level === 'WARN') console.warn(line.trimEnd());
  else console.log(line.trimEnd());
  // Append to daily log file
  try {
    await appendFile(getLogFile(), line);
  } catch {
    // If we can't write logs, at least console output is there
  }
}

const log = {
  info: (category, message, data) => write('INFO', category, message, data),
  warn: (category, message, data) => write('WARN', category, message, data),
  error: (category, message, data) => write('ERROR', category, message, data),
};

export default log;
