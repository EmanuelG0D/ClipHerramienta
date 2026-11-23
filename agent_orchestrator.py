"""Agent Orchestrator for OpenShorts AI Assistant.

Coordinates conversations with Google Antigravity (AGY) via ACP, enforces tool
whitelisting, parameter validation, intent classification, and conversational context persistence.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field

import antigravity_acp
import db_local

logger = logging.getLogger("agent_orchestrator")

ALLOWED_TOOLS = {
    "tool_create_shorts",
    "tool_list_recent_jobs",
    "tool_get_job_status",
    "tool_modify_job",
    "tool_update_preferences",
}

IntentType = Literal[
    "NEW_JOB",
    "FOLLOW_UP_NEW_JOB",
    "MODIFY_JOB",
    "QUERY_JOB",
    "CONVERSATION",
    "UPDATE_PREFERENCES",
]


# --- Pydantic Schemas for Structured Reasoning with AGY ---

class ToolInvocation(BaseModel):
    name: str = Field(description="Exact tool name: tool_create_shorts, tool_list_recent_jobs, tool_get_job_status, tool_modify_job, or tool_update_preferences")
    parameters: Dict[str, Any] = Field(default_factory=dict, description="Parameters dictionary matching the tool definition")


class AgentDecision(BaseModel):
    intent: IntentType = Field(description="Classified user intent: NEW_JOB, FOLLOW_UP_NEW_JOB, MODIFY_JOB, QUERY_JOB, CONVERSATION, or UPDATE_PREFERENCES")
    thought: str = Field(description="Step-by-step reasoning about user intention, conversation context, creative style, parameters, and action")
    action: Literal["reply_directly", "call_tool"] = Field(description="'call_tool' if a system tool must be executed, 'reply_directly' if answering conversationally, asking for missing info, or explaining limitations")
    tool_invocation: Optional[ToolInvocation] = Field(default=None, description="The tool to call if action is 'call_tool'")
    message: str = Field(description="Helpful, natural Spanish response to show to the user. Immediate confirmation if starting a job.")


# --- Tool Execution Layer ---

async def execute_tool(tool_name: str, parameters: Dict[str, Any], conv_id: Optional[str] = None) -> Dict[str, Any]:
    """Execute exclusively whitelisted internal OpenShorts tools with strict validation."""
    if tool_name not in ALLOWED_TOOLS:
        raise ValueError(f"Unauthorized tool requested: '{tool_name}'. Allowed tools: {sorted(ALLOWED_TOOLS)}")

    import app

    # Retrieve current context if conv_id provided
    ctx = db_local.get_conversation_context(conv_id) if conv_id else {}

    if tool_name == "tool_create_shorts":
        url = str(
            parameters.get("url")
            or parameters.get("source_url")
            or parameters.get("video_url")
            or parameters.get("link")
            or parameters.get("youtube_url")
            or ""
        ).strip()
        # Fallback to last_source_url from context if URL not provided
        if not url and ctx.get("last_source_url"):
            url = ctx["last_source_url"]

        if not url:
            raise ValueError("URL is required to generate shorts.")
        if not (url.startswith("http://") or url.startswith("https://")):
            raise ValueError(f"Invalid URL '{url}'. Must start with http:// or https://")

        # Extract and clamp parameters
        target_clips = parameters.get("target_clips")
        if target_clips is not None:
            try:
                target_clips = max(1, min(15, int(target_clips)))
            except (ValueError, TypeError):
                target_clips = ctx.get("last_requested_quantity") or 2
        else:
            target_clips = ctx.get("last_requested_quantity") or 2

        # Extract preferences fallback
        default_prefs = ctx.get("default_preferences", {})

        min_seconds = parameters.get("clip_min_seconds") or default_prefs.get("clip_min_seconds")
        if min_seconds is not None:
            try:
                min_seconds = max(5, min(175, int(min_seconds)))
            except (ValueError, TypeError):
                min_seconds = None

        max_seconds = parameters.get("clip_max_seconds") or default_prefs.get("clip_max_seconds")
        if max_seconds is not None:
            try:
                max_seconds = max(10, min(180, int(max_seconds)))
            except (ValueError, TypeError):
                max_seconds = None

        auto_hook = parameters.get("auto_hook")
        if auto_hook is None:
            auto_hook = default_prefs.get("auto_hook", True)
        else:
            auto_hook = bool(auto_hook)

        creative_style = parameters.get("creative_style") or default_prefs.get("creative_style")
        if creative_style:
            creative_style = str(creative_style).strip().lower()

        # Avoid previously generated clip intervals if follow-up
        avoid_ranges = parameters.get("avoid_ranges")
        if not avoid_ranges and ctx.get("previous_clips"):
            # Automatically populate avoid_ranges from previous clips of this source
            avoid_ranges = [
                [float(c["start"]), float(c["end"])]
                for c in ctx["previous_clips"]
                if "start" in c and "end" in c
            ]

        layouts = parameters.get("layouts")
        if isinstance(layouts, str):
            layouts = [layouts]
        elif not isinstance(layouts, list):
            layouts = None

        logger.info(f"Agent Orchestrator executing tool_create_shorts (url={url}, clips={target_clips}, style={creative_style})...")
        res = await app.create_video_job_internal(
            url=url,
            acknowledged=True,
            output_format="auto",
            layouts=layouts,
            target_clips=target_clips,
            clip_min_seconds=min_seconds,
            clip_max_seconds=max_seconds,
            creative_style=creative_style,
            avoid_ranges=avoid_ranges,
            auto_hook=auto_hook,
            auto_hook_style="pill",
        )

        job_id = res.get("job_id")

        # Update structured context
        if conv_id and job_id:
            prev_jobs = ctx.get("previous_jobs", [])
            new_job_entry = {
                "job_id": job_id,
                "url": url,
                "target_clips": target_clips,
                "creative_style": creative_style,
                "status": "queued",
                "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            }
            db_local.patch_conversation_context(conv_id, {
                "last_source_url": url,
                "last_job_id": job_id,
                "last_requested_quantity": target_clips,
                "last_creative_style": creative_style,
                "previous_jobs": prev_jobs + [new_job_entry],
            })

        return {
            "tool": "tool_create_shorts",
            "job_id": job_id,
            "status": res.get("status", "queued"),
            "url": url,
            "target_clips": target_clips,
            "creative_style": creative_style,
            "partial": res.get("partial"),
        }

    elif tool_name == "tool_list_recent_jobs":
        limit = parameters.get("limit", 5)
        try:
            limit = max(1, min(20, int(limit)))
        except (ValueError, TypeError):
            limit = 5

        logger.info(f"Agent Orchestrator executing tool_list_recent_jobs (limit={limit})...")
        jobs_list = app.list_recent_jobs_internal(limit=limit)
        return {
            "tool": "tool_list_recent_jobs",
            "count": len(jobs_list),
            "jobs": jobs_list,
        }

    elif tool_name == "tool_get_job_status":
        job_id = str(parameters.get("job_id") or "").strip()
        if not job_id and ctx.get("last_job_id"):
            job_id = ctx["last_job_id"]

        if not job_id:
            raise ValueError("job_id parameter is required to check job status.")

        logger.info(f"Agent Orchestrator executing tool_get_job_status (job_id={job_id})...")
        status_data = app.get_job_status_internal(job_id)
        if not status_data:
            return {
                "tool": "tool_get_job_status",
                "job_id": job_id,
                "found": False,
                "status": "not_found",
                "message": f"No se encontró ningún trabajo con ID '{job_id}'.",
            }

        clips = (status_data.get("result") or {}).get("clips", [])
        # Record completed clips in context if newly finished
        if conv_id and clips:
            current_prev_clips = ctx.get("previous_clips", [])
            existing_spans = {(c.get("start"), c.get("end")) for c in current_prev_clips}
            new_additions = []
            for clip in clips:
                s = clip.get("start")
                e = clip.get("end")
                if s is not None and e is not None and (s, e) not in existing_spans:
                    new_additions.append({
                        "start": s,
                        "end": e,
                        "title": clip.get("title", ""),
                        "job_id": job_id,
                    })
            if new_additions:
                db_local.patch_conversation_context(conv_id, {
                    "previous_clips": current_prev_clips + new_additions
                })

        return {
            "tool": "tool_get_job_status",
            "job_id": job_id,
            "found": True,
            "status": status_data.get("status"),
            "logs_tail": status_data.get("logs", [])[-3:] if status_data.get("logs") else [],
            "clips_count": len(clips),
            "result": status_data.get("result"),
        }

    elif tool_name == "tool_modify_job":
        job_id = str(parameters.get("job_id") or "").strip()
        if not job_id and ctx.get("last_job_id"):
            job_id = ctx["last_job_id"]

        if not job_id:
            raise ValueError("job_id parameter is required to modify a job.")

        changes = parameters.get("changes") or {}
        logger.info(f"Agent Orchestrator executing tool_modify_job (job_id={job_id}, changes={changes})...")
        res = app.modify_job_internal(job_id, changes)
        return {
            "tool": "tool_modify_job",
            "job_id": job_id,
            "success": res.get("success", False),
            "status": res.get("status"),
            "message": res.get("message"),
        }

    elif tool_name == "tool_update_preferences":
        new_prefs = parameters.get("preferences") or {}
        if not isinstance(new_prefs, dict):
            raise ValueError("preferences parameter must be a dictionary.")

        logger.info(f"Agent Orchestrator executing tool_update_preferences: {new_prefs}")
        if conv_id:
            current_defaults = ctx.get("default_preferences", {})
            current_defaults.update(new_prefs)
            db_local.patch_conversation_context(conv_id, {
                "default_preferences": current_defaults
            })

        return {
            "tool": "tool_update_preferences",
            "updated": True,
            "preferences": new_prefs,
            "message": "Preferencias de usuario actualizadas correctamente para las siguientes generaciones.",
        }

    raise ValueError(f"Unhandled tool: {tool_name}")


# --- Orchestrator Conversation Turn & System Prompt ---

SYSTEM_PROMPT = """Eres el Asistente de Inteligencia Artificial integrado en OpenShorts, una plataforma avanzada para crear Shorts virales de vídeo a partir de grabaciones de YouTube y podcasts.
Tu motor de razonamiento es Google Antigravity (AGY).

Tu misión es actuar como un colaborador inteligente y proactivo en español:
- Entender el contexto completo de la conversación y las fuentes ya procesadas.
- Clasificar rigurosamente la intención del usuario.
- Responder de forma ágil, concisa y profesional.

=======================================================
CATEGORÍAS DE INTENCIÓN OBLIGATORIAS:
=======================================================
Debes clasificar cada turno en exactamente una de estas intenciones (`intent`):

1. `NEW_JOB`:
   - El usuario solicita generar nuevos clips aportando un nuevo enlace o vídeo.
   - Acción: Validar parámetros, `call_tool` con `tool_create_shorts`.
   - Si no proporciona enlace y NO hay fuente previa en el contexto, usa `reply_directly` pidiéndole el link.

2. `FOLLOW_UP_NEW_JOB`:
   - El usuario pide un nuevo trabajo utilizando el contexto de una solicitud anterior (ej: "ahora sácame uno de un momento tenso", "dame otro clip", "haz 2 más").
   - Regla CRÍTICA: NO vuelvas a pedir el enlace si ya existe `last_source_url` en el contexto.
   - Acción: `call_tool` con `tool_create_shorts` reutilizando la URL anterior, configurando el nuevo `target_clips` y `creative_style` pedido, y respetando `avoid_ranges` para no repetir partes ya cortadas.
   - Crea un trabajo NUEVO con un job_id diferente.

3. `MODIFY_JOB`:
   - El usuario desea modificar preferencias de un trabajo existente (ej: "cambia el estilo a algo más divertido", "subtítulos más grandes").
   - Acción: `call_tool` con `tool_modify_job`.
   - Si la herramienta indica que el trabajo ya está en procesamiento o finalizado, explica con cortesía que un vídeo en renderizado o ya renderizado no se puede modificar sobre la marcha, y propón generar un nuevo clip de la misma fuente.

4. `QUERY_JOB`:
   - El usuario pregunta por el estado de sus trabajos (ej: "¿cómo van los vídeos?", "¿ya terminaron?", "muéstrame mis proyectos").
   - Acción: `call_tool` con `tool_get_job_status` (usando el `job_id` mencionado o el último del contexto) o `tool_list_recent_jobs`.
   - NUNCA inventes estados o resultados; básate exclusivamente en la respuesta de la herramienta.

5. `CONVERSATION`:
   - El usuario saluda, agradece, comenta el resultado o charla informalmente (ej: "gracias", "perfecto", "me encantó", "hola").
   - Acción: `reply_directly`. NO crees trabajos ni llames herramientas innecesariamente.

6. `UPDATE_PREFERENCES`:
   - El usuario establece preferencias permanentes para futuros trabajos (ej: "de ahora en adelante prioriza lo gracioso", "quiero que los clips duren entre 30 y 50 segundos").
   - Acción: `call_tool` con `tool_update_preferences`.

=======================================================
ESTILOS CREATIVOS DISPONIBLES:
=======================================================
Puedes identificar y aplicar intenciones creativas como:
- "divertido" / "gracioso"
- "tenso" / "suspense"
- "épico"
- "sorprendente" / "shock"
- "dramático"
- "caótico"
- "acción"
- "reacción inesperada"
- "polémico"
- "emocionante"

=======================================================
HERRAMIENTAS INTERNAS DISPONIBLES:
=======================================================
Cuando selecciones `action: "call_tool"`, debes proporcionar `tool_invocation` con uno de estos nombres y parámetros:
- `tool_create_shorts`: Crea un nuevo trabajo de generación de Shorts.
  Parámetros:
  - `url` (string, ej: "https://www.youtube.com/watch?v=..."): Enlace del vídeo. Opcional en FOLLOW_UP_NEW_JOB si ya existe en la conversación.
  - `target_clips` (entero, ej: 1, 2, 3): Número de clips solicitados.
  - `creative_style` (string opcional, ej: "divertido", "tenso", "épico", etc.)
  - `clip_min_seconds` (entero opcional): Duración mínima.
  - `clip_max_seconds` (entero opcional): Duración máxima.
- `tool_get_job_status`: Consulta el estado real de un trabajo.
  Parámetros:
  - `job_id` (string): Identificador del trabajo.
- `tool_modify_job`: Modifica parámetros de un trabajo.
  Parámetros:
  - `job_id` (string): Identificador del trabajo.
  - `changes` (objeto): Diccionario con los cambios solicitados.
- `tool_update_preferences`: Guarda preferencias permanentes del usuario para futuros trabajos.
  Parámetros:
  - `preferences` (objeto): Preferencias a recordar (ej: `{"creative_style": "caótico"}`).
- `tool_list_recent_jobs`: Lista trabajos recientes.
  Parámetros:
  - `limit` (entero opcional): Cantidad máxima a listar.

CRÍTICO: No intentes ejecutar código o comandos bash/terminal directamente en tu entorno. Tu respuesta debe ser ÚNICAMENTE el JSON estructurado con tu decisión (`AgentDecision`). OpenShorts ejecutará las herramientas por ti.

=======================================================
EXPERIENCIA DEL CHAT:
=======================================================
- El chat es el centro de mando; el Generador de Clips es el centro de procesamiento y seguimiento detallado.
- Cuando inicies un trabajo (`tool_create_shorts`), responde de inmediato confirmando que se ha encolado el trabajo con su ID y que puede seguir conversando libremente mientras OpenShorts trabaja en segundo plano.
"""


def _format_operative_state(ctx: Dict[str, Any]) -> str:
    """Format purely operational data (active job, clips generated) tracked by OpenShorts."""
    last_job = ctx.get("last_job_id")
    prev_clips = ctx.get("previous_clips") or []
    defaults = ctx.get("default_preferences") or {}

    lines = []
    if last_job:
        lines.append(f"- Último Job ID registrado en OpenShorts: `{last_job}`")
    if prev_clips:
        clip_spans = [
            f"[{c.get('start', 0):.1f}s - {c.get('end', 0):.1f}s: '{c.get('title', '')}']"
            for c in prev_clips[-6:]
        ]
        lines.append(f"- Tramos de tiempo ya recortados (evitar solapar): {', '.join(clip_spans)}")
    if defaults:
        lines.append(f"- Preferencias predeterminadas configuradas: {json.dumps(defaults, ensure_ascii=False)}")

    if not lines:
        return ""
    return "--- DATOS OPERATIVOS DE OPENSHORTS ---\n" + "\n".join(lines) + "\n\n"


async def process_chat_turn(conv_id: str, user_text: str) -> Dict[str, Any]:
    """Process one conversational turn: classify intent, manage native ACP session, execute tools, and reply."""
    user_text = user_text.strip()
    if not user_text:
        raise ValueError("User message cannot be empty.")

    # 1. Ensure conversation exists and record user message in SQLite for UI
    conv = db_local.get_conversation(conv_id)
    if not conv:
        conv = db_local.create_conversation(title=user_text[:40] + ("..." if len(user_text) > 40 else ""))
        conv_id = conv["id"]
    else:
        if conv.get("title") == "Nueva conversación":
            db_local.update_conversation_title(conv_id, user_text[:40] + ("..." if len(user_text) > 40 else ""))

    user_msg = db_local.add_message(conv_id, "user", user_text)

    # 2. Retrieve native AGY ACP session_id and minimal operational state
    agy_session_id = db_local.get_conversation_agy_session_id(conv_id)
    ctx = db_local.get_conversation_context(conv_id)
    operative_block = _format_operative_state(ctx)

    prompt = (
        f"{SYSTEM_PROMPT}\n\n"
        f"{operative_block}"
        f"--- MENSAJE DEL USUARIO ---\n"
        f"{user_text}\n\n"
        f"Instrucción: Clasifica la intención del usuario (`intent`), razona en `thought`, y determina la acción (`action`) y respuesta (`message`)."
    )

    # 3. Consult AGY via ACP JSON-RPC with Pydantic validation using native session context
    decision_dict, cost = await asyncio.to_thread(
        antigravity_acp.generate_json,
        prompt,
        AgentDecision,
        session_id=agy_session_id,
    )
    decision = AgentDecision.model_validate(decision_dict)

    # 4. Persist native AGY ACP session ID if new
    used_session_id = (cost or {}).get("session_id")
    if used_session_id and used_session_id != agy_session_id:
        db_local.set_conversation_agy_session_id(conv_id, used_session_id)

    task_record = None

    # 5. Handle Tool Execution if requested
    if decision.action == "call_tool" and decision.tool_invocation:
        tool_name = decision.tool_invocation.name
        tool_params = decision.tool_invocation.parameters

        task_record = db_local.create_task(
            conv_id=conv_id,
            tool_name=tool_name,
            parameters=tool_params,
            message_id=user_msg["id"],
        )

        try:
            tool_result = await execute_tool(tool_name, tool_params, conv_id=conv_id)
            job_id = tool_result.get("job_id")
            db_local.update_task(
                task_record["id"],
                status="running" if tool_name == "tool_create_shorts" else "completed",
                job_id=job_id,
                result=tool_result,
            )
            task_record = db_local.get_task_by_id(task_record["id"])

            # Formulate response based on intent and tool result
            if tool_name == "tool_create_shorts":
                qty = tool_result.get("target_clips", 2)
                style = tool_result.get("creative_style")
                style_str = f" con enfoque **{style}**" if style else ""
                asst_reply = (
                    f"¡Perfecto! He iniciado la generación de tus {qty} Shorts{style_str}. 🎬✨\n\n"
                    f"- **ID del Trabajo**: `{job_id}`\n"
                    f"- **Cantidad de clips**: {qty}\n"
                    f"- **Estado**: En cola de procesamiento\n\n"
                    f"Puedes continuar conversando conmigo mientras OpenShorts trabaja en segundo plano. Puedes consultar el progreso detallado pulsando el botón **Ver progreso** en la tarjeta inferior."
                )
            elif tool_name == "tool_modify_job":
                asst_reply = tool_result.get("message") or f"Modificación procesada para el trabajo `{job_id}`."
            elif tool_name == "tool_update_preferences":
                asst_reply = tool_result.get("message") or "Preferencias actualizadas correctamente."
            elif tool_name == "tool_list_recent_jobs":
                jobs_found = tool_result.get("jobs", [])
                if not jobs_found:
                    asst_reply = "No encontré proyectos recientes en tu espacio de trabajo. ¿Te gustaría generar unos nuevos clips a partir de un enlace de YouTube?"
                else:
                    lines = [f"Aquí tienes tus últimos {len(jobs_found)} proyectos en OpenShorts:"]
                    for j in jobs_found:
                        st = j.get("status", "unknown")
                        clips = j.get("clips_count", 0)
                        lines.append(f"• **Trabajo** `{j.get('job_id')}`: Estado **{st}** · {clips} clips")
                    lines.append("\nPuedes pedirme detalles o consultar cualquiera de ellos mencionando su ID.")
                    asst_reply = "\n".join(lines)
            elif tool_name == "tool_get_job_status":
                if not tool_result.get("found"):
                    asst_reply = f"No pude encontrar ningún trabajo registrado con el ID `{tool_params.get('job_id')}`. Por favor verifica que el identificador sea correcto."
                else:
                    st = tool_result.get("status")
                    clips = tool_result.get("clips_count", 0)
                    asst_reply = (
                        f"📊 **Estado del Trabajo `{tool_result.get('job_id')}`**:\n"
                        f"- **Estado actual**: `{st}`\n"
                        f"- **Clips generados**: {clips}\n"
                    )
                    if st in ("complete", "completed"):
                        asst_reply += "\n¡El trabajo está completo! Los clips están disponibles en el Generador de Clips."
                    elif st in ("processing", "running"):
                        asst_reply += "\nEl procesamiento sigue en curso en el pipeline de OpenShorts."
                    elif st == "queued":
                        asst_reply += "\nEl trabajo está en cola esperando su turno de procesamiento."
            else:
                asst_reply = f"Herramienta `{tool_name}` ejecutada con éxito."

        except Exception as e:
            err_msg = str(e)
            logger.error(f"Error executing tool '{tool_name}': {err_msg}")
            db_local.update_task(task_record["id"], status="failed", error_message=err_msg)
            task_record = db_local.get_task_by_id(task_record["id"])
            asst_reply = f"⚠️ Ocurrió un error al ejecutar `{tool_name}`: {err_msg}."

        asst_msg = db_local.add_message(
            conv_id=conv_id,
            sender="assistant",
            content=asst_reply,
            tool_calls=[{
                "tool": tool_name,
                "parameters": tool_params,
                "task_id": task_record["id"],
                "intent": decision.intent,
            }],
        )

    else:
        # Direct reply (CONVERSATION or clarifying question)
        asst_reply = decision.message or "Hola, ¿en qué puedo ayudarte hoy con la creación de tus Shorts?"
        asst_msg = db_local.add_message(conv_id, "assistant", asst_reply)

    return {
        "conversation_id": conv_id,
        "intent": decision.intent,
        "user_message": user_msg,
        "assistant_message": asst_msg,
        "task": task_record,
    }
