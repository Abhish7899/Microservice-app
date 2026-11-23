import os
import time
from typing import Dict, Any

from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse
import httpx

from app.logger import logger

app = FastAPI(
    title="stats-service",
    description="Stateless analytics service aggregating task statistics",
    version="1.0.0",
)


@app.middleware("http")
async def json_logging_middleware(request: Request, call_next):
    start_time = time.time()
    try:
        response = await call_next(request)
        duration_ms = round((time.time() - start_time) * 1000, 2)
        logger.info(
            "HTTP request processed",
            extra={
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "duration_ms": duration_ms,
                "client_ip": request.client.host if request.client else "unknown",
            },
        )
        return response
    except Exception as exc:
        duration_ms = round((time.time() - start_time) * 1000, 2)
        logger.error(
            "Unhandled server exception",
            extra={
                "method": request.method,
                "path": request.url.path,
                "error": str(exc),
                "duration_ms": duration_ms,
            },
            exc_info=True,
        )
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"error": "Internal Server Error", "message": "An unexpected error occurred"},
        )


@app.get("/health", status_code=status.HTTP_200_OK)
async def health_check() -> Dict[str, Any]:
    """Health check endpoint returning 200 OK."""
    return {
        "status": "UP",
        "service": "stats-service",
    }


@app.get("/api/stats")
async def get_stats():
    """
    Fetches all tasks from task-service with a strict 3-second timeout
    and computes aggregated statistics.
    """
    task_service_url = os.getenv("TASK_SERVICE_URL", "http://task-service:3000").rstrip("/")
    target_endpoint = f"{task_service_url}/api/tasks"

    logger.info(
        "Fetching tasks from task-service",
        extra={"target_endpoint": target_endpoint, "timeout_seconds": 3.0},
    )

    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(target_endpoint)

            if resp.status_code != 200:
                logger.error(
                    "task-service returned non-200 status",
                    extra={"upstream_status": resp.status_code, "target_endpoint": target_endpoint},
                )
                return JSONResponse(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    content={
                        "error": "Service Unavailable",
                        "message": f"task-service returned status {resp.status_code}",
                    },
                )

            tasks = resp.json()
    except httpx.TimeoutException as exc:
        logger.error(
            "Request to task-service timed out after 3 seconds",
            extra={"target_endpoint": target_endpoint, "error": str(exc)},
        )
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={
                "error": "Service Unavailable",
                "message": "task-service timed out after 3.0s",
            },
        )
    except httpx.RequestError as exc:
        logger.error(
            "Unable to connect to task-service",
            extra={"target_endpoint": target_endpoint, "error": str(exc)},
        )
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={
                "error": "Service Unavailable",
                "message": "task-service is unreachable",
            },
        )
    except Exception as exc:
        logger.error(
            "Unexpected error while processing stats",
            extra={"error": str(exc)},
            exc_info=True,
        )
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={
                "error": "Service Unavailable",
                "message": "Failed to retrieve statistics",
            },
        )

    if not isinstance(tasks, list):
        logger.error("Unexpected payload format from task-service (expected list)")
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={
                "error": "Service Unavailable",
                "message": "Invalid response format received from task-service",
            },
        )

    total_tasks = len(tasks)
    completed_tasks = sum(1 for t in tasks if isinstance(t, dict) and t.get("status") == "completed")
    pending_tasks = sum(1 for t in tasks if isinstance(t, dict) and t.get("status") == "pending")
    completion_rate = round(completed_tasks / total_tasks, 2) if total_tasks > 0 else 0.0

    return {
        "total_tasks": total_tasks,
        "completed_tasks": completed_tasks,
        "pending_tasks": pending_tasks,
        "completion_rate": completion_rate,
    }
