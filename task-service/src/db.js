const { Pool } = require('pg');
const logger = require('./logger');

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/tasks_db';

const poolConfig = {
  connectionString,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  max: 10,
};

// Enable SSL with self-signed / RDS certificate support when DB_SSL is set to true
if (process.env.DB_SSL === 'true') {
  poolConfig.ssl = { rejectUnauthorized: false };
}

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  logger.error('Unexpected error on idle PostgreSQL client', { error: err.message, stack: err.stack });
});

async function initDb(retries = 5, delay = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      logger.info(`Attempting database connection and schema initialization (attempt ${attempt}/${retries})`);
      const client = await pool.connect();
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS tasks (
            id SERIAL PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          );
        `);
        logger.info('Database schema initialized: tasks table verified/created');
        return;
      } finally {
        client.release();
      }
    } catch (err) {
      logger.warn(`Database connection attempt ${attempt} failed: ${err.message}`);
      if (attempt < retries) {
        await new Promise((res) => setTimeout(res, delay));
      } else {
        logger.error('Exhausted database connection retries during initialization', { error: err.message });
      }
    }
  }
}

async function checkHealth() {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    return true;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  initDb,
  checkHealth,
};
