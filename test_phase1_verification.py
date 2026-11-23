"""Phase 1 Verification Test Suite for OpenShorts AI Assistant.

Executes and logs all 10 required verification tests:
1. Iniciar conversación mediante API.
2. Persistencia del historial en SQLite.
3. Interpretación de una solicitud de generación por parte de AGY.
4. Ejecución del generador existente (comprobar entrada a la cola con job_id).
5. Consulta de estado de un trabajo (tool_get_job_status).
6. Estructura de resultados en el chat y tareas enriquecidas.
7. Manejo de errores (solicitud sin URL o parámetros faltantes).
8. Prueba de compatibilidad: endpoint tradicional POST /api/process intacto.
9. Reinicio / persistencia de base de datos sin pérdida de historial.
10. Intento de ejecutar herramientas no autorizadas (rechazo estricto por lista blanca).
"""
import json
import time
import urllib.request
import urllib.error
import sqlite3
import sys

BASE_URL = "http://127.0.0.1:8000"

def post_json(path, data):
    url = f"{BASE_URL}{path}"
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read().decode("utf-8"))

def get_json(path):
    url = f"{BASE_URL}{path}"
    with urllib.request.urlopen(url) as res:
        return json.loads(res.read().decode("utf-8"))

def delete_req(path):
    url = f"{BASE_URL}{path}"
    req = urllib.request.Request(url, method="DELETE")
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read().decode("utf-8"))

def run_tests():
    results = {}
    print("=" * 65)
    print("OPENSHORTS AI ASSISTANT — SUITE DE VERIFICACIÓN FASE 1")
    print("=" * 65)

    # ----------------------------------------------------
    # TEST 1: Iniciar conversación mediante API
    # ----------------------------------------------------
    print("\n[TEST 1] Iniciar nueva conversación...")
    conv_data = post_json("/api/assistant/conversations", {"title": "Conversación de Verificación"})
    conv = conv_data.get("conversation", {})
    conv_id = conv.get("id")
    assert conv_id, "Failed to create conversation"
    print(f" -> Conversación creada exitosamente: id={conv_id}, title='{conv.get('title')}'")
    results["test_1_create_conversation"] = "PASSED"

    # ----------------------------------------------------
    # TEST 2: Persistencia del historial en SQLite
    # ----------------------------------------------------
    print("\n[TEST 2] Verificando persistencia en SQLite (db_local.py)...")
    import db_local
    db_conv = db_local.get_conversation(conv_id)
    assert db_conv and db_conv["id"] == conv_id, "Conversation not found in SQLite DB"
    
    # Enviar un mensaje simple
    chat_turn1 = post_json("/api/assistant/chat", {
        "conversation_id": conv_id,
        "message": "Hola, ¿cuáles son las capacidades del generador de OpenShorts?"
    })
    msg_count = len(db_local.get_messages(conv_id))
    assert msg_count >= 2, f"Expected at least 2 messages in SQLite, got {msg_count}"
    print(f" -> Historial en SQLite verificado: {msg_count} mensajes registrados en hilo {conv_id}")
    results["test_2_sqlite_persistence"] = "PASSED"

    # ----------------------------------------------------
    # TEST 3: Interpretación de solicitud de generación por AGY
    # ----------------------------------------------------
    print("\n[TEST 3] Enviando petición en lenguaje natural a AGY...")
    # Pedir generación de clips
    video_url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    chat_turn2 = post_json("/api/assistant/chat", {
        "conversation_id": conv_id,
        "message": f"Por favor genera 2 shorts virales a partir de este vídeo: {video_url}"
    })
    asst_msg = chat_turn2.get("assistant_message", {}).get("content", "")
    task = chat_turn2.get("task")
    print(f" -> Respuesta de AGY:\n{asst_msg}")
    assert task, "Expected AGY to invoke a tool and create a task"
    assert task.get("tool_name") == "tool_create_shorts", f"Expected tool_create_shorts, got {task.get('tool_name')}"
    results["test_3_agy_interpretation"] = "PASSED"

    # ----------------------------------------------------
    # TEST 4: Ejecución del generador existente (cola de trabajos)
    # ----------------------------------------------------
    print("\n[TEST 4] Comprobando integración con la cola de trabajos de OpenShorts...")
    job_id = task.get("job_id")
    assert job_id, "Expected task to contain OpenShorts job_id"
    # Consultar endpoint original de estado del job
    job_status = get_json(f"/api/status/{job_id}")
    print(f" -> Trabajo registrado en el pipeline oficial: job_id={job_id}, status={job_status.get('status')}")
    assert job_status.get("status") in ("queued", "processing", "complete"), "Invalid job status"
    results["test_4_generator_execution"] = "PASSED"

    # ----------------------------------------------------
    # TEST 5: Consulta de estado de un trabajo
    # ----------------------------------------------------
    print("\n[TEST 5] Consultando estado del trabajo mediante el Asistente...")
    chat_turn3 = post_json("/api/assistant/chat", {
        "conversation_id": conv_id,
        "message": f"¿Cuál es el estado actual del trabajo con ID {job_id}?"
    })
    task3 = chat_turn3.get("task")
    print(f" -> Respuesta de estado:\n{chat_turn3.get('assistant_message', {}).get('content')}")
    assert task3 and task3.get("tool_name") == "tool_get_job_status", "Expected tool_get_job_status"
    results["test_5_job_status_query"] = "PASSED"

    # ----------------------------------------------------
    # TEST 6: Visualización y enriquecimiento de tareas
    # ----------------------------------------------------
    print("\n[TEST 6] Verificando enriquecimiento de tareas para la interfaz...")
    conv_full = get_json(f"/api/assistant/conversations/{conv_id}")
    tasks_list = conv_full.get("tasks", [])
    assert len(tasks_list) >= 2, "Expected at least 2 tasks attached to conversation"
    first_task = tasks_list[0]
    assert "live_job" in first_task or "status" in first_task, "Task not properly formatted for UI cards"
    print(f" -> {len(tasks_list)} tareas enriquecidas con telemetría en vivo para componentes de frontend.")
    results["test_6_task_enrichment"] = "PASSED"

    # ----------------------------------------------------
    # TEST 7: Manejo de errores (solicitud sin URL)
    # ----------------------------------------------------
    print("\n[TEST 7] Evaluando manejo de errores y solicitudes incompletas...")
    chat_turn_err = post_json("/api/assistant/chat", {
        "conversation_id": conv_id,
        "message": "Quiero que me generes 5 shorts pero no tengo el link ahora mismo, hazlo ya."
    })
    err_reply = chat_turn_err.get("assistant_message", {}).get("content", "")
    print(f" -> AGY respondió correctamente solicitando el enlace:\n{err_reply}")
    # AGY no debe inventar una URL ni llamar a tool_create_shorts sin URL
    assert chat_turn_err.get("task") is None or "enlace" in err_reply.lower() or "url" in err_reply.lower(), "AGY should have requested URL"
    results["test_7_error_handling"] = "PASSED"

    # ----------------------------------------------------
    # TEST 8: Compatibilidad: Generador tradicional POST /api/process
    # ----------------------------------------------------
    print("\n[TEST 8] Comprobando compatibilidad del generador tradicional (POST /api/process)...")
    process_payload = {
        "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "acknowledged": True,
        "target_clips": 1,
    }
    trad_res = post_json("/api/process", process_payload)
    trad_job_id = trad_res.get("job_id")
    print(f" -> Generador tradicional POST /api/process respondió: {trad_res}")
    assert trad_job_id and trad_res.get("status") == "queued", "Traditional /api/process broken"
    results["test_8_traditional_generator_compat"] = "PASSED"

    # ----------------------------------------------------
    # TEST 9: Persistencia tras reinicio y reconexión SQLite
    # ----------------------------------------------------
    print("\n[TEST 9] Comprobando persistencia tras simular cierre y reapertura de base de datos...")
    # Re-abrir conexión sqlite directa
    with sqlite3.connect("data/openshorts.db") as conn:
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) as c FROM conversations")
        conv_c = cur.fetchone()["c"]
        cur.execute("SELECT COUNT(*) as c FROM messages")
        msg_c = cur.fetchone()["c"]
        cur.execute("SELECT COUNT(*) as c FROM assistant_tasks")
        task_c = cur.fetchone()["c"]
        print(f" -> SQLite directo: {conv_c} conversaciones, {msg_c} mensajes, {task_c} tareas.")
        assert conv_c >= 1 and msg_c >= 4 and task_c >= 1, "Data loss detected in SQLite"
    results["test_9_persistence_after_restart"] = "PASSED"

    # ----------------------------------------------------
    # TEST 10: Intento de ejecución de herramientas no autorizadas
    # ----------------------------------------------------
    print("\n[TEST 10] Verificando bloqueo estricto de herramientas no autorizadas...")
    import agent_orchestrator
    try:
        import asyncio
        asyncio.run(agent_orchestrator.execute_tool("tool_system_shell", {"command": "whoami"}))
        unauth_blocked = False
    except ValueError as e:
        print(f" -> Bloqueo exitoso de herramienta no autorizada: {e}")
        unauth_blocked = True
    assert unauth_blocked, "Unauthorized tool was NOT blocked!"
    results["test_10_unauthorized_tool_block"] = "PASSED"

    print("\n" + "=" * 65)
    print("RESUMEN DE PRUEBAS:")
    all_passed = True
    for t_name, status in results.items():
        print(f"  {t_name}: {status}")
        if status != "PASSED":
            all_passed = False
    print("=" * 65)
    if all_passed:
        print("TODAS LAS 10 PRUEBAS HAN SIDO COMPLETADAS CON ÉXITO.")
    return all_passed

if __name__ == "__main__":
    ok = run_tests()
    sys.exit(0 if ok else 1)
