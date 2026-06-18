/* Tiny leveled logger with ANSI colors. Avoids pulling in a dependency. */

const COLORS = {
  gray: '\x1b[90m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
};

function stamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function emit(color: string, label: string, args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log(`${COLORS.gray}${stamp()}${COLORS.reset} ${color}${label}${COLORS.reset}`, ...args);
}

export const log = {
  info: (...args: unknown[]) => emit(COLORS.cyan, 'info ', args),
  warn: (...args: unknown[]) => emit(COLORS.yellow, 'warn ', args),
  error: (...args: unknown[]) => emit(COLORS.red, 'error', args),
  ok: (...args: unknown[]) => emit(COLORS.green, 'ok   ', args),
  debug: (...args: unknown[]) => {
    if (process.env.VIBE_DEBUG) emit(COLORS.gray, 'debug', args);
  },
};
