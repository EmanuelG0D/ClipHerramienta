"""Unified AI Provider Management for OpenShorts.

Supports:
1. Google Antigravity ACP (Official CLI 'agy acp', no extra API billing needed)
2. Google Gemini API (Google AI Studio API Key)
3. Ollama (Local OpenAI-compatible server, e.g. http://localhost:11434/v1)
4. LM Studio (Local OpenAI-compatible server, e.g. http://localhost:1234/v1)
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
from typing import Any, Dict, List, Optional, Tuple, Type

import httpx
from pydantic import BaseModel

import antigravity_acp

logger = logging.getLogger("ai_providers")
CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ai_provider_config.json")

PROVIDER_ANTIGRAVITY = "antigravity"
PROVIDER_GEMINI = "gemini"
PROVIDER_OLLAMA = "ollama"
PROVIDER_LMSTUDIO = "lmstudio"

DEFAULT_OLLAMA_URL = "http://localhost:11434/v1"
DEFAULT_LMSTUDIO_URL = "http://localhost:1234/v1"
DEFAULT_TIMEOUT = 600.0


def _load_persisted_config() -> dict:
    if os.path.isfile(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.warning(f"Could not read {CONFIG_FILE}: {e}")
    return {}


def _save_persisted_config(cfg: dict) -> None:
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
    except Exception as e:
        logger.error(f"Failed to save {CONFIG_FILE}: {e}")


def get_active_provider_name() -> str:
    """Determine the active AI provider from env, config or available tools."""
    # 1. Explicit environment variable takes highest priority
    env_p = (os.environ.get("LLM_PROVIDER") or "").strip().lower()
    if env_p in ("antigravity", "agy", "acp"):
        return PROVIDER_ANTIGRAVITY
    if env_p in ("ollama",):
        return PROVIDER_OLLAMA
    if env_p in ("lmstudio", "lm-studio"):
        return PROVIDER_LMSTUDIO
    if env_p in ("openai", "local", "openai-compatible"):
        return PROVIDER_OLLAMA
    if env_p == "gemini":
        return PROVIDER_GEMINI

    # 2. If LLM_BASE_URL is set without explicit provider, it's OpenAI-compatible
    if os.environ.get("LLM_BASE_URL"):
        return PROVIDER_OLLAMA

    # 3. If running pytest and no local URL/provider is explicitly set, default to gemini
    if os.environ.get("PYTEST_CURRENT_TEST") and not os.environ.get("LLM_PROVIDER"):
        return PROVIDER_GEMINI

    # 4. Persisted user choice in config file
    saved = _load_persisted_config()
    if saved.get("active_provider"):
        return saved["active_provider"]

    # 5. Auto-detect: if agy is installed and supported, use Antigravity!
    agy_info = antigravity_acp.get_agy_info()
    if agy_info["installed"] and agy_info["acp_supported"]:
        return PROVIDER_ANTIGRAVITY

    return PROVIDER_GEMINI


def get_provider_config(provider_name: Optional[str] = None) -> dict:
    """Retrieve settings for a given provider or the active one."""
    provider = provider_name or get_active_provider_name()
    saved = _load_persisted_config()
    provider_saved = saved.get("providers", {}).get(provider, {})

    if provider == PROVIDER_ANTIGRAVITY:
        return {
            "provider": PROVIDER_ANTIGRAVITY,
            "model": provider_saved.get("model") or os.environ.get("ANTIGRAVITY_MODEL") or os.environ.get("LLM_MODEL") or "gemini-3.8-flash-high",
        }
    elif provider == PROVIDER_OLLAMA:
        return {
            "provider": PROVIDER_OLLAMA,
            "base_url": provider_saved.get("base_url") or os.environ.get("LLM_BASE_URL") or DEFAULT_OLLAMA_URL,
            "model": provider_saved.get("model") or os.environ.get("LLM_MODEL") or "qwen2.5:14b",
            "api_key": provider_saved.get("api_key") or os.environ.get("LLM_API_KEY") or "ollama",
        }
    elif provider == PROVIDER_LMSTUDIO:
        return {
            "provider": PROVIDER_LMSTUDIO,
            "base_url": provider_saved.get("base_url") or os.environ.get("LLM_BASE_URL") or DEFAULT_LMSTUDIO_URL,
            "model": provider_saved.get("model") or os.environ.get("LLM_MODEL") or "local-model",
            "api_key": provider_saved.get("api_key") or os.environ.get("LLM_API_KEY") or "",
        }
    else:  # Gemini
        return {
            "provider": PROVIDER_GEMINI,
            "api_key": provider_saved.get("api_key") or os.environ.get("GEMINI_API_KEY") or "",
            "model": provider_saved.get("model") or os.environ.get("GEMINI_MODEL") or "gemini-3.1-flash-lite",
        }


def set_active_provider(provider_name: str, settings: Optional[dict] = None) -> dict:
    """Save selected provider and its settings."""
    saved = _load_persisted_config()
    saved["active_provider"] = provider_name
    if "providers" not in saved:
        saved["providers"] = {}
    if settings:
        saved["providers"][provider_name] = {**saved["providers"].get(provider_name, {}), **settings}
    _save_persisted_config(saved)

    # Update environment for subprocesses if applicable
    cfg = get_provider_config(provider_name)
    if provider_name == PROVIDER_ANTIGRAVITY:
        os.environ["LLM_PROVIDER"] = "antigravity"
        os.environ["ANTIGRAVITY_MODEL"] = cfg.get("model", "gemini-3.8-flash-high")
    elif provider_name in (PROVIDER_OLLAMA, PROVIDER_LMSTUDIO):
        os.environ["LLM_PROVIDER"] = "openai"
        os.environ["LLM_BASE_URL"] = cfg.get("base_url", "")
        os.environ["LLM_MODEL"] = cfg.get("model", "")
        if cfg.get("api_key"):
            os.environ["LLM_API_KEY"] = cfg["api_key"]
    elif provider_name == PROVIDER_GEMINI:
        os.environ["LLM_PROVIDER"] = "gemini"
        if cfg.get("api_key"):
            os.environ["GEMINI_API_KEY"] = cfg["api_key"]
        if cfg.get("model"):
            os.environ["GEMINI_MODEL"] = cfg["model"]

    return get_all_providers_status()


def test_provider_connection(provider_name: str, settings: Optional[dict] = None) -> Dict[str, Any]:
    """Test connectivity for the designated provider."""
    cfg = {**get_provider_config(provider_name), **(settings or {})}

    if provider_name == PROVIDER_ANTIGRAVITY:
        auth_status = antigravity_acp.check_auth_status()
        if not auth_status["installed"]:
            return {"ok": False, "provider": provider_name, "error": auth_status["error"] or "Antigravity CLI ('agy') is not installed."}
        if not auth_status["acp_supported"]:
            return {"ok": False, "provider": provider_name, "error": auth_status["error"] or "Antigravity CLI does not support ACP."}
        if not auth_status["authenticated"]:
            return {
                "ok": False,
                "provider": provider_name,
                "authenticated": False,
                "error": "Antigravity is installed but not authenticated. Please log in with Google.",
            }
        return {
            "ok": True,
            "provider": provider_name,
            "authenticated": True,
            "tier": auth_status.get("tier"),
            "models": auth_status.get("models", []),
            "current_model": cfg.get("model") or auth_status.get("current_model"),
            "message": f"Connected to Google Antigravity ACP ({auth_status.get('tier', 'Authenticated')})",
        }

    elif provider_name == PROVIDER_GEMINI:
        api_key = cfg.get("api_key") or os.environ.get("GEMINI_API_KEY")
        if not api_key:
            return {"ok": False, "provider": provider_name, "error": "Gemini API key is required."}
        try:
            from google import genai
            client = genai.Client(api_key=api_key)
            models = list(client.models.list(config={"page_size": 10}))
            model_names = [m.name for m in models if hasattr(m, "name")]
            return {
                "ok": True,
                "provider": provider_name,
                "authenticated": True,
                "models": model_names[:10],
                "message": "Gemini API key verified successfully.",
            }
        except Exception as e:
            return {"ok": False, "provider": provider_name, "error": f"Gemini API verification failed: {e}"}

    elif provider_name in (PROVIDER_OLLAMA, PROVIDER_LMSTUDIO):
        base_url = (cfg.get("base_url") or "").rstrip("/")
        if not base_url:
            return {"ok": False, "provider": provider_name, "error": "Base URL endpoint is required."}

        models_url = f"{base_url}/models"
        headers = {}
        if cfg.get("api_key"):
            headers["Authorization"] = f"Bearer {cfg['api_key']}"

        try:
            with httpx.Client(timeout=8.0) as client:
                resp = client.get(models_url, headers=headers)
                if resp.status_code != 200 and provider_name == PROVIDER_OLLAMA:
                    parent_url = base_url.rsplit("/v1", 1)[0]
                    resp = client.get(f"{parent_url}/api/tags")

                if resp.status_code >= 400:
                    return {"ok": False, "provider": provider_name, "error": f"Server responded with HTTP {resp.status_code}: {resp.text[:200]}"}

                data = resp.json()
                models = []
                if "data" in data and isinstance(data["data"], list):
                    models = [m.get("id") for m in data["data"] if isinstance(m, dict) and "id" in m]
                elif "models" in data and isinstance(data["models"], list):
                    models = [m.get("name") for m in data["models"] if isinstance(m, dict) and "name" in m]

                return {
                    "ok": True,
                    "provider": provider_name,
                    "endpoint": base_url,
                    "models": models,
                    "message": f"Successfully connected to {provider_name.upper()}! Found {len(models)} model(s).",
                }
        except Exception as e:
            return {"ok": False, "provider": provider_name, "error": f"Connection failed to {base_url}: {e}"}

    return {"ok": False, "provider": provider_name, "error": f"Unknown provider: {provider_name}"}


def get_all_providers_status() -> Dict[str, Any]:
    """Retrieve full diagnostic and configuration status for all 4 providers."""
    active = get_active_provider_name()

    # 1. Antigravity ACP
    agy_info = antigravity_acp.get_agy_info()
    agy_status: Dict[str, Any] = {
        "id": PROVIDER_ANTIGRAVITY,
        "name": "Google Antigravity ACP",
        "description": "Official Antigravity CLI via ACP protocol. No extra API billing required.",
        "installed": agy_info["installed"],
        "version": agy_info["version"],
        "acp_supported": agy_info["acp_supported"],
        "path": agy_info["path"],
        "config": get_provider_config(PROVIDER_ANTIGRAVITY),
    }
    if agy_info["installed"] and agy_info["acp_supported"]:
        auth = antigravity_acp.check_auth_status(timeout=5.0)
        agy_status["authenticated"] = auth.get("authenticated", False)
        agy_status["tier"] = auth.get("tier")
        agy_status["available_models"] = auth.get("models", [])
        agy_status["current_model"] = agy_status["config"].get("model") or auth.get("current_model")
        agy_status["error"] = auth.get("error")
    else:
        agy_status["authenticated"] = False
        agy_status["tier"] = None
        agy_status["available_models"] = []
        agy_status["current_model"] = None
        agy_status["error"] = agy_info["error"]

    # 2. Gemini API
    gemini_cfg = get_provider_config(PROVIDER_GEMINI)
    gemini_status = {
        "id": PROVIDER_GEMINI,
        "name": "Gemini API",
        "description": "Google AI Studio API key.",
        "configured": bool(gemini_cfg.get("api_key")),
        "config": {
            "model": gemini_cfg.get("model", "gemini-3.1-flash-lite"),
            "has_key": bool(gemini_cfg.get("api_key")),
        },
    }

    # 3. Ollama
    ollama_cfg = get_provider_config(PROVIDER_OLLAMA)
    ollama_status = {
        "id": PROVIDER_OLLAMA,
        "name": "Ollama",
        "description": "Local open-weights LLMs via Ollama OpenAI-compatible endpoint.",
        "config": ollama_cfg,
    }

    # 4. LM Studio
    lmstudio_cfg = get_provider_config(PROVIDER_LMSTUDIO)
    lmstudio_status = {
        "id": PROVIDER_LMSTUDIO,
        "name": "LM Studio",
        "description": "Local models via LM Studio OpenAI-compatible endpoint.",
        "config": lmstudio_cfg,
    }

    return {
        "active_provider": active,
        "providers": {
            PROVIDER_ANTIGRAVITY: agy_status,
            PROVIDER_GEMINI: gemini_status,
            PROVIDER_OLLAMA: ollama_status,
            PROVIDER_LMSTUDIO: lmstudio_status,
        },
    }


def launch_antigravity_login() -> Dict[str, Any]:
    """Trigger the official interactive Google login process via `agy acp --login`."""
    agy_path = antigravity_acp.find_agy_executable()
    if not agy_path:
        return {"ok": False, "error": "Antigravity CLI ('agy') not found on this system."}

    try:
        if sys.platform == "win32":
            subprocess.Popen(["cmd.exe", "/c", "start", agy_path, "acp", "--login"])
        else:
            subprocess.Popen([agy_path, "acp", "--login"])
        return {"ok": True, "message": "Terminal authentication window opened. Please complete login in your browser."}
    except Exception as e:
        return {"ok": False, "error": f"Failed to start login process: {e}"}


def is_active() -> bool:
    """True if Antigravity or an OpenAI-compatible server is active (Gemini key not required)."""
    active = get_active_provider_name()
    if active == PROVIDER_ANTIGRAVITY:
        return True
    if active in (PROVIDER_OLLAMA, PROVIDER_LMSTUDIO):
        cfg = get_provider_config(active)
        return bool(cfg.get("base_url"))
    return False


def describe_for_dashboard() -> Optional[dict]:
    """What `/api/config` tells the dashboard frontend."""
    active = get_active_provider_name()
    cfg = get_provider_config(active)
    if active == PROVIDER_ANTIGRAVITY:
        agy_info = antigravity_acp.get_agy_info()
        return {
            "provider": PROVIDER_ANTIGRAVITY,
            "name": "Google Antigravity ACP",
            "model": cfg.get("model", "gemini-3.8-flash-high"),
            "installed": agy_info["installed"],
            "acp_supported": agy_info["acp_supported"],
            "tier": "Google AI Pro",
        }
    elif active in (PROVIDER_OLLAMA, PROVIDER_LMSTUDIO):
        return {
            "provider": active,
            "name": active.upper(),
            "model": cfg.get("model", ""),
            "baseUrl": cfg.get("base_url", ""),
        }
    return None
