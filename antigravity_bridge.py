"""Local Antigravity Bridge for Docker or Remote Workers.

Runs on the Windows host machine to bridge Docker containers (or any local client)
to the authenticated Antigravity CLI via ACP (Agent Client Protocol).

Provides a secure, standard OpenAI-compatible HTTP interface:
  POST /v1/chat/completions
  GET  /v1/models
  GET  /health

Usage:
  python antigravity_bridge.py [--port 8001] [--host 0.0.0.0]
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from typing import Any, Dict, List, Optional

from pydantic import BaseModel
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import antigravity_acp
import ai_providers

logging.basicConfig(level=logging.INFO, format="[AntigravityBridge] %(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("antigravity_bridge")

app = FastAPI(title="OpenShorts Antigravity ACP Host Bridge", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class GenericSchema(BaseModel):
    # Flexible schema container
    pass


@app.get("/health")
async def health_check():
    auth = antigravity_acp.check_auth_status(timeout=10.0)
    return {
        "status": "ok" if auth.get("authenticated") else "degraded",
        "antigravity": auth,
    }


@app.get("/v1/models")
async def list_models():
    auth = antigravity_acp.check_auth_status(timeout=5.0)
    models_list = auth.get("models") or [
        {"modelId": "gemini-3.8-flash-high", "name": "Gemini 3.8 Flash (High)"},
        {"modelId": "gemini-3.8-flash-medium", "name": "Gemini 3.8 Flash (Medium)"},
        {"modelId": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6 (Thinking)"},
    ]
    return {
        "object": "list",
        "data": [
            {
                "id": m.get("modelId") or m.get("id"),
                "object": "model",
                "created": int(time.time()),
                "owned_by": "google-antigravity",
                "permission": [],
            }
            for m in models_list
        ],
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    """OpenAI-compatible chat completion endpoint powered by Antigravity ACP."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    messages = body.get("messages", [])
    model = body.get("model") or "gemini-3.8-flash-high"

    # Assemble prompt from messages
    prompt_parts = []
    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if isinstance(content, list):
            content = " ".join(c.get("text", "") for c in content if isinstance(c, dict))
        prompt_parts.append(f"[{role.upper()}]:\n{content}")

    full_prompt = "\n\n".join(prompt_parts)

    try:
        client = antigravity_acp.get_or_create_client(model=model)
        raw_text, usage = client.prompt(full_prompt)
    except Exception as e:
        logger.error(f"Error executing ACP prompt: {e}")
        raise HTTPException(status_code=500, detail=f"Antigravity ACP error: {e}")

    # Build standard OpenAI response structure
    res = {
        "id": f"chatcmpl-agy-{int(time.time()*1000)}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": raw_text,
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": int(usage.get("inputTokens") or usage.get("input_tokens") or 0),
            "completion_tokens": int(usage.get("outputTokens") or usage.get("output_tokens") or 0),
            "total_tokens": int(usage.get("totalTokens") or usage.get("total_tokens") or 0),
        },
    }
    return JSONResponse(content=res)


def main():
    parser = argparse.ArgumentParser(description="Antigravity ACP Host Bridge for OpenShorts Docker/Local")
    parser.add_argument("--host", default="0.0.0.0", help="Host interface to bind (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8001, help="Port to listen on (default: 8001)")
    args = parser.parse_args()

    info = antigravity_acp.get_agy_info()
    if not info["installed"]:
        logger.warning("Antigravity CLI ('agy') not found! Please ensure 'agy' is installed.")
    else:
        logger.info(f"Antigravity CLI found at: {info['path']} (v{info['version']})")

    logger.info(f"Starting Antigravity Bridge on http://{args.host}:{args.port}")
    logger.info(f"Docker containers can connect via: http://host.docker.internal:{args.port}/v1")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
