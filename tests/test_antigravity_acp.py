"""Tests for Google Antigravity ACP integration and multi-provider architecture."""
import json
import os
import pytest
from pydantic import BaseModel

import antigravity_acp
import ai_providers
import llm_backend
from gemini_worker import ScoreResponse, DetailResponse


def test_agy_info():
    info = antigravity_acp.get_agy_info()
    assert isinstance(info, dict)
    assert "installed" in info
    assert "acp_supported" in info
    # On this machine, agy is installed
    assert info["installed"] is True
    assert info["acp_supported"] is True
    assert info["path"] is not None


def test_json_extraction():
    # Raw JSON
    raw = '{"status": "ok"}'
    assert antigravity_acp._extract_json_from_text(raw) == {"status": "ok"}

    # Markdown fenced JSON
    fenced = '```json\n{"windows": [{"id": "w1", "score": 90, "reason": "hook"}]}\n```'
    assert antigravity_acp._extract_json_from_text(fenced)["windows"][0]["score"] == 90

    # With surrounding prose
    prose = 'Here is your result:\n{"windows": []}\nHope this helps!'
    assert antigravity_acp._extract_json_from_text(prose) == {"windows": []}


def test_auth_status():
    status = antigravity_acp.check_auth_status(timeout=15.0)
    assert status["installed"] is True
    assert status["acp_supported"] is True
    assert status["authenticated"] is True
    assert status["tier"] is not None
    assert len(status["models"]) > 0


def test_providers_status_listing():
    status = ai_providers.get_all_providers_status()
    assert "active_provider" in status
    assert "providers" in status
    providers = status["providers"]
    assert "antigravity" in providers
    assert "gemini" in providers
    assert "ollama" in providers
    assert "lmstudio" in providers

    agy = providers["antigravity"]
    assert agy["installed"] is True
    assert agy["acp_supported"] is True


def test_provider_selection_and_switch(monkeypatch):
    # Set active provider to ollama
    ai_providers.set_active_provider("ollama", {"base_url": "http://localhost:11434/v1", "model": "test-model"})
    assert ai_providers.get_active_provider_name() == "ollama"

    # Switch back to antigravity
    ai_providers.set_active_provider("antigravity", {"model": "gemini-3.8-flash-high"})
    assert ai_providers.get_active_provider_name() == "antigravity"


def test_antigravity_moment_generation():
    prompt = """
    Evaluate this window. Return JSON strictly matching:
    {"windows": [{"id": "win_1", "start": 0.0, "end": 45.0, "score": 85, "reason": "Strong viral hook"}]}

    Candidate:
    [{"id": "win_1", "start": 0.0, "end": 45.0, "text": "Viral hook opener that grabs audience attention!"}]
    """
    res, cost = antigravity_acp.generate_json(prompt, ScoreResponse, model="gemini-3.8-flash-high")
    assert "windows" in res
    assert len(res["windows"]) > 0
    first = res["windows"][0]
    assert first["id"] == "win_1"
    assert isinstance(first["score"], int)
    assert cost["total_cost"] == 0.0
    assert cost["local"] is True
    assert cost["provider"] == "antigravity"
