const express = require('express');
const logger = require('./logger');
const { pool, initDb, checkHealth } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Structured JSON request logger middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info('HTTP request processed', {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration_ms: duration,
      ip: req.ip || req.connection.remoteAddress,
    });
  });
  next();
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    await checkHealth();
    return res.status(200).json({
      status: 'UP',
      service: 'task-service',
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('Health check failed - database unavailable', { error: err.message });
    return res.status(503).json({
      status: 'DOWN',
      service: 'task-service',
      database: 'disconnected',
      error: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// GET /api/tasks - List all tasks
app.get('/api/tasks', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, title, status, created_at FROM tasks ORDER BY id ASC'
    );
    res.status(200).json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/tasks - Create task
app.post('/api/tasks', async (req, res, next) => {
  try {
    const { title, status } = req.body;

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'Title is required and must be a non-empty string',
      });
    }

    const taskStatus = status ? status.toLowerCase() : 'pending';
    if (!['pending', 'completed'].includes(taskStatus)) {
      return res.status(400).json({
        error: 'Validation Error',
        message: "Status must be either 'pending' or 'completed'",
      });
    }

    const result = await pool.query(
      'INSERT INTO tasks (title, status) VALUES ($1, $2) RETURNING id, title, status, created_at',
      [title.trim(), taskStatus]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/tasks/:id - Update status
app.patch('/api/tasks/:id', async (req, res, next) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    if (isNaN(taskId)) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'Task ID must be an integer',
      });
    }

    const { status } = req.body;
    if (!status || typeof status !== 'string') {
      return res.status(400).json({
        error: 'Validation Error',
        message: "Status is required and must be either 'pending' or 'completed'",
      });
    }

    const taskStatus = status.toLowerCase();
    if (!['pending', 'completed'].includes(taskStatus)) {
      return res.status(400).json({
        error: 'Validation Error',
        message: "Status must be either 'pending' or 'completed'",
      });
    }

    const result = await pool.query(
      'UPDATE tasks SET status = $1 WHERE id = $2 RETURNING id, title, status, created_at',
      [taskStatus, taskId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: 'Not Found',
        message: `Task with id ${taskId} not found`,
      });
    }

    res.status(200).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/tasks/:id - Delete task
app.delete('/api/tasks/:id', async (req, res, next) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    if (isNaN(taskId)) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'Task ID must be an integer',
      });
    }

    const result = await pool.query(
      'DELETE FROM tasks WHERE id = $1 RETURNING id',
      [taskId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: 'Not Found',
        message: `Task with id ${taskId} not found`,
      });
    }

    res.status(200).json({
      message: 'Task deleted successfully',
      id: taskId,
    });
  } catch (err) {
    next(err);
  }
});

// Centralized error handler middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled application error', {
    error: err.message,
    stack: err.stack,
    method: req.method,
    path: req.originalUrl,
  });

  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message || 'An unexpected error occurred',
  });
});

// Startup sequence
async function startServer() {
  await initDb();
  app.listen(PORT, () => {
    logger.info(`task-service started successfully`, {
      port: PORT,
      node_env: process.env.NODE_ENV || 'development',
    });
  });
}

startServer().catch((err) => {
  logger.error('Failed to start task-service', { error: err.message, stack: err.stack });
  process.exit(1);
});
