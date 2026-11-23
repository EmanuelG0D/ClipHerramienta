"""Google Antigravity ACP (Agent Client Protocol) adapter for OpenShorts.

Communicates with the official Antigravity CLI (`agy acp`) via JSON-RPC 2.0
over stdio to provide AI reasoning for moment scoring and clip detail extraction
without requiring a Gemini API key or extra API billing.
"""
from __future__ import annotations

import base64
import json
import logging
import mimetypes
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
from typing import Any, Dict, List, Optional, Tuple, Type

from pydantic import BaseModel

logger = logging.getLogger("antigravity_acp")
if not logger.handlers:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("[AntigravityACP] %(asctime)s - %(levelname)s - %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

DEFAULT_TIMEOUT = 600.0


def find_agy_executable() -> Optional[str]:
    """Find the path to the official `agy` executable."""
    # 1. Custom environment variable
    custom = os.environ.get("AGY_PATH")
    if custom and os.path.isfile(custom):
        return custom

    # 2. Standard PATH lookup
    in_path = shutil.which("agy")
    if in_path:
        return in_path

    # 3. Windows standard locations
    if sys.platform == "win32":
        user_profile = os.environ.get("USERPROFILE", "")
        candidates = [
            os.path.join(user_profile, "AppData", "Local", "agy", "bin", "agy.exe"),
            os.path.join(user_profile, "AppData", "Local", "Programs", "agy", "agy.exe"),
            os.path.join(os.environ.get("ProgramFiles", "C:\\Program Files"), "agy", "agy.exe"),
            os.path.join(os.environ.get("ProgramFiles(x86)", "C:\\Program Files (x86)"), "agy", "agy.exe"),
        ]
        for path in candidates:
            if os.path.isfile(path):
                return path
    else:
        # Linux / macOS standard locations
        home = os.path.expanduser("~")
        candidates = [
            os.path.join(home, ".agy", "bin", "agy"),
            "/usr/local/bin/agy",
            "/usr/bin/agy",
            "/opt/homebrew/bin/agy",
        ]
        for path in candidates:
            if os.path.isfile(path):
                return path

    return None


def get_agy_info() -> Dict[str, Any]:
    """Inspect the installed Antigravity CLI and report version & ACP capability."""
    agy_path = find_agy_executable()
    if not agy_path:
        return {
            "installed": False,
            "path": None,
            "version": None,
            "acp_supported": False,
            "error": "Antigravity CLI ('agy') not found on this system.",
        }

    # Check version
    try:
        ver_proc = subprocess.run([agy_path, "--version"], capture_output=True, text=True, timeout=10, encoding="utf-8")
        version_str = ver_proc.stdout.strip() or ver_proc.stderr.strip()
    except Exception as e:
        return {
            "installed": True,
            "path": agy_path,
            "version": None,
            "acp_supported": False,
            "error": f"Failed to execute agy --version: {e}",
        }

    # Check ACP subcommand support
    try:
        acp_proc = subprocess.run([agy_path, "acp", "--help"], capture_output=True, text=True, timeout=10, encoding="utf-8")
        acp_supported = acp_proc.returncode == 0 or "acp" in acp_proc.stdout.lower()
    except Exception:
        acp_supported = False

    return {
        "installed": True,
        "path": agy_path,
        "version": version_str,
        "acp_supported": acp_supported,
        "error": None if acp_supported else "The installed 'agy' version does not appear to support the 'acp' command.",
    }


def check_auth_status(timeout: float = 25.0) -> Dict[str, Any]:
    """Probe Antigravity ACP to check whether the user has an active Google authentication."""
    info = get_agy_info()
    if not info["installed"]:
        return {
            "installed": False,
            "acp_available": False,
            "authenticated": False,
            "tier": None,
            "models": [],
            "current_model": None,
            "error": info["error"],
        }
    if not info["acp_supported"]:
        return {
            "installed": True,
            "acp_available": False,
            "authenticated": False,
            "tier": None,
            "models": [],
            "current_model": None,
            "error": info["error"],
        }

    # Attempt a quick session creation handshake with `agy acp`
    try:
        client = AntigravityACPClient(agy_path=info["path"], timeout=timeout)
        client.start()
        client.initialize()
        session_data = client.create_session()
        client.close()

        models_info = session_data.get("models", {})
        available_models = models_info.get("availableModels", [])
        current_model = models_info.get("currentModelId")
        tier_info = session_data.get("_meta", {}).get("antigravity", {}).get("tier", {})
        tier_name = tier_info.get("name", "Google Antigravity User")

        return {
            "installed": True,
            "acp_available": True,
            "acp_supported": True,
            "authenticated": True,
            "tier": tier_name,
            "models": available_models,
            "current_model": current_model,
            "error": None,
        }
    except Exception as e:
        err_msg = str(e)
        logger.warning(f"ACP auth check returned: {err_msg}")
        return {
            "installed": True,
            "acp_available": True,
            "acp_supported": True,
            "authenticated": False,
            "tier": None,
            "models": [],
            "current_model": None,
            "error": f"Authentication required or ACP check failed: {err_msg}",
        }


def _extract_json_from_text(text: str) -> Any:
    """Extract valid JSON object or array from LLM response text."""
    text = text.strip()
    if not text:
        raise ValueError("Empty response text from Antigravity agent")

    # 1. Direct parse attempt
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # 2. Extract from markdown code fences ```json ... ```
    pattern = r"```(?:json)?\s*([\s\S]*?)\s*```"
    matches = re.findall(pattern, text, re.IGNORECASE)
    for m in matches:
        m = m.strip()
        try:
            return json.loads(m)
        except json.JSONDecodeError:
            continue

    # 3. Locate outer braces { ... } or [ ... ]
    start_brace = text.find("{")
    end_brace = text.rfind("}")
    if start_brace != -1 and end_brace > start_brace:
        candidate = text[start_brace : end_brace + 1]
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass

    start_bracket = text.find("[")
    end_bracket = text.rfind("]")
    if start_bracket != -1 and end_bracket > start_bracket:
        candidate = text[start_bracket : end_bracket + 1]
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass

    raise ValueError(f"Could not parse valid JSON from text: {text[:250]}...")


SUPPORTED_IMAGE_MIMES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
}


def _detect_image_mime(data: bytes, filename: Optional[str] = None) -> Optional[str]:
    """Detect image MIME type from file extension or magic bytes."""
    if filename:
        ext = os.path.splitext(filename)[1].lower()
        ext_map = {
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".webp": "image/webp",
            ".gif": "image/gif",
        }
        if ext in ext_map:
            return ext_map[ext]

    if len(data) >= 3 and data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if len(data) >= 8 and data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if len(data) >= 6 and (data[:6] == b"GIF87a" or data[:6] == b"GIF89a"):
        return "image/gif"

    return None


def format_image_block(image_input: Any) -> Dict[str, Any]:
    """Format an image input (file path, raw bytes, or dict) into an ACP image content block.

    Output block format:
    {"type": "image", "data": "<base64_string>", "mimeType": "<mime_type>"}
    """
    if isinstance(image_input, dict):
        if image_input.get("type") == "image" and "data" in image_input and "mimeType" in image_input:
            mime = image_input["mimeType"]
            if mime not in SUPPORTED_IMAGE_MIMES:
                raise ValueError(f"Unsupported image mimeType: '{mime}'. Supported: {sorted(SUPPORTED_IMAGE_MIMES)}")
            return {
                "type": "image",
                "data": image_input["data"],
                "mimeType": mime,
            }
        elif "bytes" in image_input:
            raw_bytes = image_input["bytes"]
            mime = image_input.get("mimeType") or _detect_image_mime(raw_bytes)
            if not mime or mime not in SUPPORTED_IMAGE_MIMES:
                raise ValueError("Could not determine valid supported MIME type for image bytes")
            b64_str = base64.b64encode(raw_bytes).decode("ascii")
            return {"type": "image", "data": b64_str, "mimeType": mime}

    if isinstance(image_input, (str, os.PathLike)):
        path_str = str(image_input)
        if not os.path.isfile(path_str):
            raise FileNotFoundError(f"Image file not found: {path_str}")
        with open(path_str, "rb") as f:
            raw_bytes = f.read()
        mime = _detect_image_mime(raw_bytes, filename=path_str)
        if not mime or mime not in SUPPORTED_IMAGE_MIMES:
            raise ValueError(f"Unsupported image format for '{path_str}'. Supported: {sorted(SUPPORTED_IMAGE_MIMES)}")
        b64_str = base64.b64encode(raw_bytes).decode("ascii")
        return {"type": "image", "data": b64_str, "mimeType": mime}

    if isinstance(image_input, (bytes, bytearray)):
        raw_bytes = bytes(image_input)
        if len(raw_bytes) == 0:
            raise ValueError("Empty image bytes provided.")
        mime = _detect_image_mime(raw_bytes)
        if not mime or mime not in SUPPORTED_IMAGE_MIMES:
            raise ValueError(f"Could not detect valid supported image MIME type from bytes. Supported: {sorted(SUPPORTED_IMAGE_MIMES)}")
        b64_str = base64.b64encode(raw_bytes).decode("ascii")
        return {"type": "image", "data": b64_str, "mimeType": mime}

    raise TypeError(f"Unsupported image input type: {type(image_input)}. Expected path (str), bytes, or image dict.")


class AntigravityACPClient:
    """Manages an active `agy acp` JSON-RPC 2.0 stdio server session."""

    def __init__(self, agy_path: Optional[str] = None, model: Optional[str] = None, timeout: float = DEFAULT_TIMEOUT):
        self.agy_path = agy_path or find_agy_executable()
        if not self.agy_path:
            raise RuntimeError("Antigravity CLI ('agy') executable could not be found.")
        self.model = model
        self.timeout = timeout
        self.proc: Optional[subprocess.Popen] = None
        self._msg_id = 0
        self._lock = threading.Lock()
        self.session_id: Optional[str] = None
        self.init_result: Optional[dict] = None
        self.session_result: Optional[dict] = None
        self._stderr_lines: List[str] = []
        self._stderr_thread: Optional[threading.Thread] = None

    def start(self) -> None:
        """Spawn the `agy acp --stdio` process."""
        cmd = [self.agy_path, "acp", "--stdio"]
        logger.info(f"Starting Antigravity ACP subprocess: {' '.join(cmd)}")
        self.proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )

        def _drain_stderr():
            try:
                for line in self.proc.stderr:
                    clean = line.strip()
                    if clean:
                        self._stderr_lines.append(clean)
                        if len(self._stderr_lines) > 200:
                            self._stderr_lines.pop(0)
            except Exception:
                pass

        self._stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
        self._stderr_thread.start()

    def _next_id(self) -> int:
        self._msg_id += 1
        return self._msg_id

    def _send_rpc(self, method: str, params: Optional[dict] = None) -> int:
        if not self.proc or self.proc.poll() is not None:
            raise RuntimeError("Antigravity ACP process is not running.")
        req_id = self._next_id()
        msg: Dict[str, Any] = {"jsonrpc": "2.0", "id": req_id, "method": method}
        if params is not None:
            msg["params"] = params
        line = json.dumps(msg)
        try:
            self.proc.stdin.write(line + "\n")
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError) as e:
            raise RuntimeError(f"Failed to write to ACP stdin: {e}")
        return req_id

    def _read_line_with_timeout(self, timeout: float) -> str:
        if not self.proc or not self.proc.stdout:
            raise RuntimeError("ACP stdout is not available.")
        line = self.proc.stdout.readline()
        if not line:
            if self.proc.poll() is not None:
                err_summary = "\n".join(self._stderr_lines[-10:])
                raise RuntimeError(f"ACP process exited prematurely with code {self.proc.returncode}. Stderr: {err_summary}")
            raise RuntimeError("ACP server closed stdout.")
        return line.strip()

    def initialize(self) -> dict:
        """Perform ACP initialization handshake."""
        req_id = self._send_rpc("initialize", {
            "protocolVersion": 1,
            "clientCapabilities": {
                "fs": {"read": True, "write": True},
                "terminal": True,
            },
            "clientInfo": {
                "name": "OpenShorts-ACP-Adapter",
                "version": "1.0.0",
            },
        })

        start = time.time()
        while time.time() - start < 30.0:
            raw = self._read_line_with_timeout(30.0)
            if not raw:
                continue
            data = json.loads(raw)
            if data.get("id") == req_id:
                if "error" in data:
                    raise RuntimeError(f"ACP initialize error: {data['error']}")
                self.init_result = data.get("result", {})
                return self.init_result

        raise TimeoutError("Timed out waiting for ACP initialize response.")

    def create_session(self, cwd: Optional[str] = None) -> dict:
        """Create a new ACP session with workspace cwd and optional model."""
        target_cwd = os.path.abspath(cwd or ".")
        req_id = self._send_rpc("session/new", {
            "cwd": target_cwd,
            "mcpServers": [],
        })

        start = time.time()
        while time.time() - start < 30.0:
            raw = self._read_line_with_timeout(30.0)
            if not raw:
                continue
            data = json.loads(raw)
            if data.get("id") == req_id:
                if "error" in data:
                    raise RuntimeError(f"ACP session/new error: {data['error']}")
                res = data.get("result", {})
                self.session_id = res.get("sessionId")
                self.session_result = res
                break

        if not self.session_id:
            raise RuntimeError("Failed to obtain sessionId from ACP session/new.")

        # If a custom model is requested, try setting it
        if self.model:
            try:
                self.set_model(self.model)
            except Exception as e:
                logger.warning(f"Could not set ACP model {self.model}: {e}")

        return self.session_result

    def load_session(self, session_id: str, cwd: Optional[str] = None) -> dict:
        """Load an existing ACP session by its sessionId to preserve native conversational context."""
        if not session_id:
            raise ValueError("session_id is required for load_session.")
        target_cwd = os.path.abspath(cwd or ".")
        req_id = self._send_rpc("session/load", {
            "sessionId": session_id,
            "cwd": target_cwd,
        })

        start = time.time()
        while time.time() - start < 30.0:
            raw = self._read_line_with_timeout(30.0)
            if not raw:
                continue
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue

            if data.get("id") == req_id:
                if "error" in data:
                    raise RuntimeError(f"ACP session/load error: {data['error']}")
                res = data.get("result", {})
                self.session_id = session_id
                self.session_result = res
                logger.info(f"Successfully loaded existing ACP session: {session_id}")
                return res

        raise TimeoutError(f"Timed out waiting for ACP session/load response for session {session_id}.")

    def set_model(self, model_name: str) -> None:
        """Select a model for the active ACP session using `session/set_config_option`."""
        if not self.session_id:
            raise RuntimeError("No active session.")
        req_id = self._send_rpc("session/set_config_option", {
            "sessionId": self.session_id,
            "configId": "model",
            "value": model_name,
        })
        # Wait briefly for response
        start = time.time()
        while time.time() - start < 10.0:
            raw = self._read_line_with_timeout(10.0)
            if not raw:
                continue
            data = json.loads(raw)
            if data.get("id") == req_id:
                break

    def prompt(self, prompt_text: str, session_id: Optional[str] = None) -> Tuple[str, dict]:
        """Send a prompt turn and stream updates until turn completes."""
        if session_id and session_id != self.session_id:
            try:
                self.load_session(session_id)
            except Exception as e:
                logger.warning(f"Could not load session {session_id} ({e}); creating a new session.")
                self.create_session()
        elif not self.session_id:
            self.create_session()

        with self._lock:
            req_id = self._send_rpc("session/prompt", {
                "sessionId": self.session_id,
                "prompt": [
                    {"type": "text", "text": prompt_text},
                ],
            })

            accumulated_chunks: List[str] = []
            turn_usage: dict = {}
            start_time = time.time()

            while True:
                if time.time() - start_time > self.timeout:
                    self.close()
                    raise TimeoutError(f"Antigravity ACP prompt timed out after {self.timeout}s")

                raw = self._read_line_with_timeout(self.timeout)
                if not raw:
                    continue

                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                # 1. Check for incoming server notifications
                if msg.get("method") == "session/update":
                    update = msg.get("params", {}).get("update", {})
                    # Agent streamed message chunk
                    if update.get("sessionUpdate") == "agent_message_chunk":
                        content = update.get("content", {})
                        if isinstance(content, dict) and content.get("type") == "text":
                            accumulated_chunks.append(content.get("text", ""))
                        elif isinstance(update.get("text"), str):
                            accumulated_chunks.append(update.get("text", ""))
                    continue

                # 2. Check for incoming server permission requests (deny external actions in inference mode)
                if msg.get("method") == "session/request_permission":
                    perm_id = msg.get("id")
                    if perm_id is not None:
                        resp_line = json.dumps({"jsonrpc": "2.0", "id": perm_id, "result": {"outcome": "deny"}})
                        self.proc.stdin.write(resp_line + "\n")
                        self.proc.stdin.flush()
                    continue

                # 3. Check for the final response matching our prompt req_id
                if msg.get("id") == req_id:
                    if "error" in msg:
                        raise RuntimeError(f"Antigravity ACP prompt error: {msg['error']}")
                    result = msg.get("result", {})
                    turn_usage = result.get("usage", {})
                    break

            full_text = "".join(accumulated_chunks)
            return full_text, turn_usage

    def prompt_multimodal(self, prompt_text: str, image_blocks: List[dict], session_id: Optional[str] = None) -> Tuple[str, dict]:
        """Send a multimodal prompt turn (text + images) and stream updates until turn completes."""
        if session_id and session_id != self.session_id:
            try:
                self.load_session(session_id)
            except Exception as e:
                logger.warning(f"Could not load session {session_id} ({e}); creating a new session.")
                self.create_session()
        elif not self.session_id:
            self.create_session()

        with self._lock:
            prompt_content: List[Dict[str, Any]] = [{"type": "text", "text": prompt_text}]
            prompt_content.extend(image_blocks)

            req_id = self._send_rpc("session/prompt", {
                "sessionId": self.session_id,
                "prompt": prompt_content,
            })

            accumulated_chunks: List[str] = []
            turn_usage: dict = {}
            start_time = time.time()

            while True:
                if time.time() - start_time > self.timeout:
                    self.close()
                    raise TimeoutError(f"Antigravity ACP multimodal prompt timed out after {self.timeout}s")

                raw = self._read_line_with_timeout(self.timeout)
                if not raw:
                    continue

                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                # 1. Check for incoming server notifications
                if msg.get("method") == "session/update":
                    update = msg.get("params", {}).get("update", {})
                    # Agent streamed message chunk
                    if update.get("sessionUpdate") == "agent_message_chunk":
                        content = update.get("content", {})
                        if isinstance(content, dict) and content.get("type") == "text":
                            accumulated_chunks.append(content.get("text", ""))
                        elif isinstance(update.get("text"), str):
                            accumulated_chunks.append(update.get("text", ""))
                    continue

                # 2. Check for incoming server permission requests (deny external actions in inference mode)
                if msg.get("method") == "session/request_permission":
                    perm_id = msg.get("id")
                    if perm_id is not None:
                        resp_line = json.dumps({"jsonrpc": "2.0", "id": perm_id, "result": {"outcome": "deny"}})
                        self.proc.stdin.write(resp_line + "\n")
                        self.proc.stdin.flush()
                    continue

                # 3. Check for the final response matching our prompt req_id
                if msg.get("id") == req_id:
                    if "error" in msg:
                        raise RuntimeError(f"Antigravity ACP prompt error: {msg['error']}")
                    result = msg.get("result", {})
                    turn_usage = result.get("usage", {})
                    break

            full_text = "".join(accumulated_chunks)
            return full_text, turn_usage

    def close(self) -> None:
        """Close the ACP subprocess cleanly."""
        if self.proc:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=3.0)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass
            self.proc = None
            self.session_id = None


# Persistent singleton client or process manager for efficiency
_CLIENT_LOCK = threading.Lock()
_ACTIVE_CLIENT: Optional[AntigravityACPClient] = None


def get_or_create_client(
    model: Optional[str] = None,
    timeout: float = DEFAULT_TIMEOUT,
    session_id: Optional[str] = None,
) -> AntigravityACPClient:
    """Obtain an initialized Antigravity ACP client instance, optionally loading a specific session."""
    global _ACTIVE_CLIENT
    with _CLIENT_LOCK:
        if _ACTIVE_CLIENT and _ACTIVE_CLIENT.proc and _ACTIVE_CLIENT.proc.poll() is None:
            _ACTIVE_CLIENT.timeout = timeout
            # Check if model switch requested
            if model and _ACTIVE_CLIENT.model != model:
                try:
                    _ACTIVE_CLIENT.set_model(model)
                    _ACTIVE_CLIENT.model = model
                except Exception:
                    pass
            # Load specific session if requested and different from current
            if session_id:
                if _ACTIVE_CLIENT.session_id != session_id:
                    try:
                        _ACTIVE_CLIENT.load_session(session_id)
                    except Exception as e:
                        logger.warning(f"Failed to load requested ACP session {session_id} ({e}); creating new session")
                        _ACTIVE_CLIENT.create_session()
            else:
                # If no session_id was passed, create a fresh independent session
                _ACTIVE_CLIENT.create_session()
            return _ACTIVE_CLIENT

        # Create fresh client
        if _ACTIVE_CLIENT:
            try:
                _ACTIVE_CLIENT.close()
            except Exception:
                pass

        client = AntigravityACPClient(model=model, timeout=timeout)
        client.start()
        client.initialize()
        if session_id:
            try:
                client.load_session(session_id)
            except Exception as e:
                logger.warning(f"Failed to load ACP session {session_id} on startup ({e}); creating new session")
                client.create_session()
        else:
            client.create_session()
        _ACTIVE_CLIENT = client
        return _ACTIVE_CLIENT


def _fallback_generate_with_agy_cli(prompt: str, model: Optional[str] = None) -> Tuple[str, dict]:
    """Fallback generator using direct `agy -p ... --output-format json` if ACP stdio server drops."""
    agy_path = find_agy_executable()
    if not agy_path:
        raise RuntimeError("Antigravity CLI ('agy') not found.")

    cmd = [agy_path, "-p", prompt]
    if model:
        cmd.extend(["--model", model])

    logger.info(f"Executing fallback agy CLI prompt (model={model or 'default'})...")
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=DEFAULT_TIMEOUT, encoding="utf-8")
    if res.returncode != 0:
        raise RuntimeError(f"agy CLI fallback failed (code {res.returncode}): {res.stderr[:300]}")

    return res.stdout, {}


def generate_json(
    prompt: str,
    schema: Type[BaseModel],
    model: Optional[str] = None,
    timeout: float = DEFAULT_TIMEOUT,
    session_id: Optional[str] = None,
) -> Tuple[dict, Optional[dict]]:
    """Complete a reasoning turn via Antigravity ACP and return (validated_dict, cost_dict).

    Matches the exact interface and return signature of OpenShorts `main._run_gemini_stage`
    and `llm_backend.generate_json`. Supports per-conversation session_id for native ACP context.
    """
    selected_model = model or os.environ.get("ANTIGRAVITY_MODEL") or os.environ.get("LLM_MODEL") or "gemini-3.8-flash-high"
    logger.info(f"Antigravity ACP generating structured response (model={selected_model}, session_id={session_id or 'auto'})...")

    # Add strict JSON reminder to prompt
    schema_json = json.dumps(schema.model_json_schema())
    enforced_prompt = (
        f"{prompt}\n\n"
        f"Required JSON Schema:\n{schema_json}\n\n"
        "CRITICAL INSTRUCTION: Respond ONLY with a single valid JSON object strictly matching the required schema. "
        "Do NOT include any introductory or concluding text, explanations, or conversational filler."
    )

    full_text = ""
    usage: dict = {}
    client: Optional[AntigravityACPClient] = None

    try:
        client = get_or_create_client(model=selected_model, timeout=timeout, session_id=session_id)
        full_text, usage = client.prompt(enforced_prompt, session_id=session_id)
    except Exception as e:
        logger.warning(f"ACP stdio turn failed ({e}); attempting clean reconnection or CLI fallback...")
        # Reset active client
        global _ACTIVE_CLIENT
        with _CLIENT_LOCK:
            if _ACTIVE_CLIENT:
                try:
                    _ACTIVE_CLIENT.close()
                except Exception:
                    pass
                _ACTIVE_CLIENT = None

        # Try once more with fresh ACP client or fallback to agy -p
        try:
            client = get_or_create_client(model=selected_model, timeout=timeout, session_id=session_id)
            full_text, usage = client.prompt(enforced_prompt, session_id=session_id)
        except Exception as e2:
            logger.warning(f"Fresh ACP turn failed ({e2}); running direct agy CLI fallback...")
            with _CLIENT_LOCK:
                if _ACTIVE_CLIENT:
                    try:
                        _ACTIVE_CLIENT.close()
                    except Exception:
                        pass
                    _ACTIVE_CLIENT = None
            full_text, usage = _fallback_generate_with_agy_cli(enforced_prompt, model=selected_model)

    # Check for content policy blocks from Google Antigravity
    lower_res = full_text.lower()
    if any(tok in lower_res for tok in ("prohibited use policy", "sensitive words", "prohibited_content", "generative ai prohibited")):
        try:
            import gemini_worker
            raise gemini_worker.GeminiBlockedError(f"Antigravity safety filter blocked prompt: {full_text.strip()[:200]}")
        except ImportError:
            raise ValueError(f"Content policy block: {full_text.strip()[:200]}")

    # Parse and validate JSON
    parsed = _extract_json_from_text(full_text)
    validated = schema.model_validate(parsed).model_dump()

    cost = {
        "input_tokens": int(usage.get("inputTokens") or usage.get("input_tokens") or 0),
        "output_tokens": int(usage.get("outputTokens") or usage.get("output_tokens") or 0),
        "thinking_tokens": int(usage.get("thoughtTokens") or usage.get("thinking_tokens") or 0),
        "input_cost": 0.0,
        "output_cost": 0.0,
        "total_cost": 0.0,
        "model": selected_model,
        "price_estimated": False,
        "local": True,
        "provider": "antigravity",
        "session_id": client.session_id if client else session_id,
    }

    return validated, cost


def generate_multimodal_json(
    prompt: str,
    schema: Type[BaseModel],
    images: List[Any],
    model: Optional[str] = None,
    timeout: float = DEFAULT_TIMEOUT,
    session_id: Optional[str] = None,
) -> Tuple[dict, Optional[dict]]:
    """Complete a multimodal reasoning turn via Antigravity ACP and return (validated_dict, cost_dict).

    Matches the exact interface and return signature of generate_json, accepting one or more images
    (as file paths, bytes, or image dicts).
    """
    if not images:
        raise ValueError("At least one image must be provided to generate_multimodal_json.")

    image_blocks = [format_image_block(img) for img in images]
    selected_model = model or os.environ.get("ANTIGRAVITY_MODEL") or os.environ.get("LLM_MODEL") or "gemini-3.8-flash-high"
    logger.info(f"Antigravity ACP generating multimodal structured response ({len(image_blocks)} images, model={selected_model}, session_id={session_id or 'auto'})...")

    # Add strict JSON reminder to prompt
    schema_json = json.dumps(schema.model_json_schema())
    enforced_prompt = (
        f"{prompt}\n\n"
        f"Required JSON Schema:\n{schema_json}\n\n"
        "CRITICAL INSTRUCTION: Respond ONLY with a single valid JSON object strictly matching the required schema. "
        "Do NOT include any introductory or concluding text, explanations, or conversational filler."
    )

    full_text = ""
    usage: dict = {}
    client: Optional[AntigravityACPClient] = None

    try:
        client = get_or_create_client(model=selected_model, timeout=timeout, session_id=session_id)
        full_text, usage = client.prompt_multimodal(enforced_prompt, image_blocks, session_id=session_id)
    except Exception as e:
        logger.warning(f"ACP stdio multimodal turn failed ({e}); attempting clean reconnection...")
        # Reset active client
        global _ACTIVE_CLIENT
        with _CLIENT_LOCK:
            if _ACTIVE_CLIENT:
                try:
                    _ACTIVE_CLIENT.close()
                except Exception:
                    pass
                _ACTIVE_CLIENT = None

        # Retry once with fresh ACP client
        try:
            client = get_or_create_client(model=selected_model, timeout=timeout, session_id=session_id)
            full_text, usage = client.prompt_multimodal(enforced_prompt, image_blocks, session_id=session_id)
        except Exception:
            with _CLIENT_LOCK:
                if _ACTIVE_CLIENT:
                    try:
                        _ACTIVE_CLIENT.close()
                    except Exception:
                        pass
                    _ACTIVE_CLIENT = None
            raise

    # Check for content policy blocks from Google Antigravity
    lower_res = full_text.lower()
    if any(tok in lower_res for tok in ("prohibited use policy", "sensitive words", "prohibited_content", "generative ai prohibited")):
        try:
            import gemini_worker
            raise gemini_worker.GeminiBlockedError(f"Antigravity safety filter blocked prompt: {full_text.strip()[:200]}")
        except ImportError:
            raise ValueError(f"Content policy block: {full_text.strip()[:200]}")

    # Parse and validate JSON
    parsed = _extract_json_from_text(full_text)
    validated = schema.model_validate(parsed).model_dump()

    cost = {
        "input_tokens": int(usage.get("inputTokens") or usage.get("input_tokens") or 0),
        "output_tokens": int(usage.get("outputTokens") or usage.get("output_tokens") or 0),
        "thinking_tokens": int(usage.get("thoughtTokens") or usage.get("thinking_tokens") or 0),
        "input_cost": 0.0,
        "output_cost": 0.0,
        "total_cost": 0.0,
        "model": selected_model,
        "price_estimated": False,
        "local": True,
        "provider": "antigravity",
        "session_id": client.session_id if client else session_id,
    }

    return validated, cost
