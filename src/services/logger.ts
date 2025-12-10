import winston from 'winston';
import { config } from '../config/index.js';
import path from 'path';

const logsDir = path.join(process.cwd(), 'logs');

const logger = winston.createLogger({
  level: config.logging.level,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'superfetch' },
  transports: [
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 5242880,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5242880,
      maxFiles: 5,
    }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    })
  );
}

export function logInfo(message: string, meta?: Record<string, unknown>): void {
  if (config.logging.enabled) logger.info(message, meta);
}

export function logWarn(message: string, meta?: Record<string, unknown>): void {
  if (config.logging.enabled) logger.warn(message, meta);
}

export function logDebug(
  message: string,
  meta?: Record<string, unknown>
): void {
  if (config.logging.enabled) logger.debug(message, meta);
}

export function logError(
  message: string,
  error?: Error | Record<string, unknown>
): void {
  if (!config.logging.enabled) return;

  const errorMeta =
    error instanceof Error
      ? { error: error.message, stack: error.stack }
      : error;
  logger.error(message, errorMeta);
}
