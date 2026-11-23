const log = (level, message, meta = {}) => {
  const entry = {
    timestamp: new Date().toISOString(),
    service: 'task-service',
    level,
    message,
    ...meta,
  };
  process.stdout.write(JSON.stringify(entry) + '\n');
};

const logger = {
  info: (message, meta) => log('INFO', message, meta),
  warn: (message, meta) => log('WARN', message, meta),
  error: (message, meta) => log('ERROR', message, meta),
};

module.exports = logger;
