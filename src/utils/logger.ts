import { config } from './config';

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

const logLevelMap: { [key: string]: LogLevel } = {
  error: LogLevel.ERROR,
  warn: LogLevel.WARN,
  info: LogLevel.INFO,
  debug: LogLevel.DEBUG,
};

const currentLogLevel = logLevelMap[config.logLevel] || LogLevel.INFO;

function formatMessage(level: string, message: string, ...args: any[]): string {
  const timestamp = new Date().toISOString();
  const formattedArgs = args.length > 0 ? ` ${JSON.stringify(args)}` : '';
  return `[${timestamp}] ${level.toUpperCase()}: ${message}${formattedArgs}`;
}

export const logger = {
  error: (message: string, ...args: any[]): void => {
    if (currentLogLevel >= LogLevel.ERROR) {
      console.error(formatMessage('error', message, ...args));
    }
  },
  
  warn: (message: string, ...args: any[]): void => {
    if (currentLogLevel >= LogLevel.WARN) {
      console.warn(formatMessage('warn', message, ...args));
    }
  },
  
  info: (message: string, ...args: any[]): void => {
    if (currentLogLevel >= LogLevel.INFO) {
      console.info(formatMessage('info', message, ...args));
    }
  },
  
  debug: (message: string, ...args: any[]): void => {
    if (currentLogLevel >= LogLevel.DEBUG) {
      console.log(formatMessage('debug', message, ...args));
    }
  },
};
