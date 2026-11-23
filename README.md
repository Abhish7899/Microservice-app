# Cloud-Native 2-Service Microservice Platform

A lightweight, production-ready 2-service microservice application in a monorepo built for AWS DevOps practice (ECS Fargate, EKS, Docker Compose, CI/CD pipelines, and CloudWatch).

---

## 1. Architecture Overview

The system consists of two decoupled microservices communicating over HTTP/REST on an isolated internal network:

```
                      +---------------------------------------+
                      |             Client / ALB              |
                      +-------------------+-------------------+
                                          |
                        +-----------------+-----------------+
                        |                                   |
                 :3000  v                            :4000  v
       +-----------------------+             +-----------------------+
       |     task-service      |<------------|     stats-service     |
       | (Node.js / Express)   | HTTP GET    |   (Python / FastAPI)  |
       | Non-root user:appuser | /api/tasks  | Non-root user:appuser |
       +-----------+-----------+             +-----------------------+
                   |
            :5432  | PostgreSQL wire
                   v
       +-----------------------+
       |       PostgreSQL      |
       |   (postgres:16-alpine)|
       +-----------------------+
```

### Components

1. **`task-service` (Node.js 20 + Express + PostgreSQL)**
   - Port: `3000`
   - Role: State authority and persistent CRUD API for tasks.
   - Database: Connects to PostgreSQL using `DATABASE_URL`. Automatically creates the `tasks` table on boot if it does not exist (`id`, `title`, `status`, `created_at`).
   - Security: Runs as an unprivileged user (`appuser`, group `appgroup`) inside a minimal `node:20-alpine` container.
   - Observability: Emits structured JSON logs to `stdout` for all requests and application errors.

2. **`stats-service` (Python 3.12 + FastAPI + httpx)**
   - Port: `4000`
   - Role: Stateless aggregator that computes task completion statistics without any direct database access.
   - Resilience: Requests `${TASK_SERVICE_URL}/api/tasks` with a strict **3.0-second timeout**. If `task-service` is unreachable or times out, it responds cleanly with `503 Service Unavailable` rather than crashing.
   - Security: Runs as an unprivileged user (`appuser`, group `appgroup`) inside a minimal `python:3.12-slim` container.
   - Observability: Emits structured JSON logs to `stdout`.

3. **`PostgreSQL` (postgres:16-alpine)**
   - Port: `5432`
   - Persistent database container equipped with `pg_isready` healthcheck.

---

## 2. Directory Layout

```
.
├── .dockerignore
├── .env.example              # Template for environment variables (do NOT commit .env)
├── .gitignore                # Git ignore for Node, Python, logs, and environments
├── docker-compose.yml        # Multi-container local orchestration with healthchecks
├── README.md                 # System documentation & runbook
├── stats-service/            # Python / FastAPI statistics service
│   ├── app/
│   │   ├── __init__.py
│   │   ├── logger.py         # JSON structured logging formatter and handler
│   │   └── main.py           # FastAPI routes, upstream client & 503 error handling
│   ├── .dockerignore
│   ├── Dockerfile            # python:3.12-slim with explicit non-root user
│   └── requirements.txt
└── task-service/             # Node.js / Express task service
    ├── src/
    │   ├── db.js             # PostgreSQL connection pool and auto-migration
    │   ├── index.js          # Express server and task CRUD routes
    │   └── logger.js         # JSON structured logging utility
    ├── .dockerignore
    ├── Dockerfile            # node:20-alpine with explicit non-root user
    ├── package.json
    └── package-lock.json
```

---

## 3. Environment Variables

Copy `.env.example` to `.env` before running locally:

```bash
cp .env.example .env
```

| Variable | Service | Default in Compose | Description |
|---|---|---|---|
| `POSTGRES_USER` | postgres | `postgres` | Database admin user |
| `POSTGRES_PASSWORD` | postgres | `postgres` | Database admin password |
| `POSTGRES_DB` | postgres | `tasks_db` | Application database name |
| `POSTGRES_PORT` | postgres / host | `5432` | Exposed host port for Postgres |
| `TASK_SERVICE_PORT` | task-service | `3000` | Exposed host port for task-service |
| `DATABASE_URL` | task-service | `postgresql://postgres:postgres@postgres:5432/tasks_db` | Connection string to PostgreSQL |
| `NODE_ENV` | task-service | `production` | Node.js execution environment |
| `STATS_SERVICE_PORT`| stats-service | `4000` | Exposed host port for stats-service |
| `TASK_SERVICE_URL` | stats-service | `http://task-service:3000` | Internal URL to reach task-service |

> **Note:** Never commit `.env` containing sensitive credentials to Git. `.env` is ignored by `.gitignore`.

---

## 4. Local Run Commands (Docker Compose)

### Start all services
```bash
docker compose up -d --build
```

### Inspect service status and health checks
```bash
docker compose ps
```
Both `task-service` and `stats-service` will wait for `postgres` to report healthy before starting up.

### View structured JSON logs
```bash
# Follow all logs
docker compose logs -f

# Follow a specific service
docker compose logs -f task-service
docker compose logs -f stats-service
```

### Stop all services and clean up volumes
```bash
docker compose down -v
```

---

## 5. API Reference & Verification

### Health Checks

```bash
# task-service health (validates DB connectivity, returns 200 or 503)
curl -i http://localhost:3000/health

# stats-service health (returns 200 OK)
curl -i http://localhost:4000/health
```

### Task CRUD Endpoints (`task-service` on `:3000`)

```bash
# 1. Create a task (POST /api/tasks)
curl -s -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title": "Deploy microservices to AWS ECS", "status": "pending"}' | jq .

# 2. List all tasks (GET /api/tasks)
curl -s http://localhost:3000/api/tasks | jq .

# 3. Update task status (PATCH /api/tasks/:id)
curl -s -X PATCH http://localhost:3000/api/tasks/1 \
  -H "Content-Type: application/json" \
  -d '{"status": "completed"}' | jq .

# 4. Delete a task (DELETE /api/tasks/:id)
curl -s -X DELETE http://localhost:3000/api/tasks/1 | jq .
```

### Analytics Endpoint (`stats-service` on `:4000`)

```bash
# Get aggregated statistics (GET /api/stats)
curl -s http://localhost:4000/api/stats | jq .
```

Example response:
```json
{
  "total_tasks": 2,
  "completed_tasks": 1,
  "pending_tasks": 1,
  "completion_rate": 0.5
}
```

### Resilience & Failure Testing

To verify `stats-service` gracefully handles upstream failure:
```bash
# Temporarily pause or stop task-service
docker compose stop task-service

# Query stats-service (should return 503 cleanly without crashing)
curl -i http://localhost:4000/api/stats

# Restart task-service
docker compose start task-service
```

---

## 6. AWS DevOps Readiness

- **Container Security**: Explicit non-root users (`appuser:appgroup`) prevent host privilege escalation.
- **Minimal Surface**: Alpine and Debian-slim base images drastically minimize CVE counts and image layer sizes.
- **ALB / Target Group Compatible**: Dedicated `/health` endpoints return standard HTTP status codes (`200 OK` on healthy, `503 Service Unavailable` on unhealthy) matching AWS Target Group health checks.
- **Structured JSON Logging**: Every log line follows `{ "timestamp": "...", "service": "...", "level": "...", "message": "..." }`, making ingestion into AWS CloudWatch Logs, OpenSearch, or Datadog seamless with JSON metric filters.
