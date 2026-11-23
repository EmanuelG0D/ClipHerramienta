# Integración de Google Antigravity ACP (`agy acp`)

Este documento describe la arquitectura, protocolo y configuración de la integración oficial entre **OpenShorts** y **Google Antigravity** mediante su CLI oficial y el protocolo **ACP (Agent Control Protocol)**.

---

## 1. ¿Qué es Google Antigravity ACP?

Google Antigravity incluye una interfaz de control de agentes por protocolo (**ACP**) disponible a través de su comando oficial:
```powershell
agy acp --stdio
```

A diferencia de un endpoint HTTP convencional de completado de texto, ACP es un protocolo estructurado basado en **JSON-RPC 2.0 sobre flujos estándar (stdio)**. Permite a extensiones de IDEs y aplicaciones autorizadas interactuar de forma bidireccional con los agentes de razonamiento de Google Antigravity, aprovechando la sesión autenticada del usuario en su cuenta de Google (incluyendo suscripciones como *Google AI Pro*), **sin necesidad de adquirir créditos adicionales en Google Cloud / Gemini API**.

---

## 2. Requisitos y Comprobación de `agy`

### A. Verificar si `agy` está instalado
Ejecuta en PowerShell:
```powershell
agy --version
```
Si el comando no está reconocido, verifica las siguientes rutas habituales en Windows:
- `%LOCALAPPDATA%\agy\bin\agy.exe`
- `C:\Users\<TU_USUARIO>\AppData\Local\agy\bin\agy.exe`

El backend de OpenShorts busca automáticamente en el `PATH` del sistema y en esta ruta predeterminada de Windows.

### B. Verificar soporte de ACP
Comprueba que el subcomando `acp` esté disponible:
```powershell
agy acp --help
```

### C. Autenticación con Google
Si no has iniciado sesión o tu token ha expirado:
```powershell
agy auth login
# o bien:
agy acp --login
```
Esto abrirá la ventana oficial del navegador de Google para que autorices tu cuenta de forma segura.

Para verificar el estado actual de tu sesión:
```powershell
agy auth status
```
La salida mostrará tu correo, estado (`Logged in`), nivel de suscripción y límites vigentes.

---

## 3. Protocolo de Comunicación ACP (JSON-RPC 2.0)

La implementación se encuentra en `antigravity_acp.py`. Funciona arrancando `agy.exe acp --stdio` como subproceso e intercambiando mensajes JSON delimitados por saltos de línea (`\n`).

### Ciclo de vida de una sesión ACP

```
OpenShorts (Backend)                           Antigravity CLI (agy acp)
        │                                                 │
        │─── 1. initialize {"protocolVersion": 1} ───────>│
        │<── 2. result {"protocolVersion": 1, ...} ───────│
        │                                                 │
        │─── 3. session/new {"cwd": "..."} ──────────────>│
        │<── 4. result {"sessionId": "...", "models":...} │
        │                                                 │
        │─── 5. session/prompt {sessionId, prompt, ...} ─>│
        │<── 6. notification: session/update (stream) ────│
        │<── 7. result {"status": "ok"} ──────────────────│
        │                                                 │
        ▼                                                 ▼
```

1. **Inicialización (`initialize`)**:
   - Envía `{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": 1}}`.
   - `agy` responde confirmando las capacidades y la versión del protocolo.

2. **Creación de Sesión (`session/new`)**:
   - Envía el directorio de trabajo y obtiene el `sessionId` activo, así como la lista de modelos permitidos para la cuenta autenticada.

3. **Ejecución de Instrucciones (`session/prompt`)**:
   - Se envía la instrucción del análisis viral junto con el esquema JSON exigido.
   - `agy acp` transmite fragmentos de respuesta mediante notificaciones `session/update` con `sessionUpdate: "agent_message_chunk"`.
   - Cuando concluye el turno, emite la respuesta final de la llamada.

4. **Validación de Esquema con Pydantic**:
   - El JSON devuelto es parseado y validado contra los esquemas oficiales de OpenShorts:
     - `ScoreResponse` (Paso 1: evaluación de ventanas temporales de virilidad).
     - `DetailResponse` (Paso 2: títulos optimizados, ganchos de retención, justificación y marcas de tiempo exactas).

---

## 4. Modelos Disponibles en Antigravity

Dependiendo de tu cuenta y plan de Google Antigravity, dispones de varios modelos de razonamiento:

| Modelo | Recomendado para | Velocidad |
|---|---|---|
| `gemini-3.8-flash-high` | **(Recomendado por defecto)** Selección viral rápida y precisa | Muy alta |
| `gemini-3.8-flash-medium` | Videos largos con transcripciones extensas | Muy alta |
| `gemini-3.8-flash-low` | Menor consumo de cuota por llamada | Ultra rápida |
| `claude-sonnet-4-6` | Análisis profundo de retención y ganchos | Alta |
| `claude-opus-4-6-thinking` | Razonamiento reflexivo exhaustivo | Media |
| `gpt-oss-120b-medium` | Alternativa de código abierto en Antigravity | Alta |

Puedes seleccionar el modelo desde la interfaz web de OpenShorts o mediante la variable de entorno `AI_MODEL`.

---

## 5. Puente para Docker (`antigravity_bridge.py`)

Si ejecutas OpenShorts en Docker en Windows, el contenedor no puede interactuar directamente con `agy.exe` vía stdio. Para habilitarlo:

1. Ejecuta el puente en el sistema host (Windows):
   ```powershell
   .\.venv\Scripts\python.exe antigravity_bridge.py --host 0.0.0.0 --port 8001
   ```
2. El puente expone una API REST local (`/v1/chat/completions`) que traduce las peticiones HTTP del contenedor Docker a comandos ACP del host.
3. El contenedor Docker se conecta mediante:
   ```ini
   LLM_BASE_URL=http://host.docker.internal:8001/v1
   ```
4. El puente incluye validación de salud (`/health`), registro detallado y reinicio automático de sesiones ACP.

---

## 6. Seguridad y Cumplimiento

La integración con Antigravity en OpenShorts cumple estrictamente con las políticas de Google:
- **No extrae ni manipula tokens OAuth**: Toda la autenticación es gestionada internamente por el binario oficial `agy.exe`.
- **Sin acceso a archivos privados**: No se leen cookies ni archivos de sesión internos.
- **Sin elusión de límites**: No se intentan evitar cuotas ni se realizan peticiones web no documentadas.
- **Transparencia de costos**: El cálculo de costo reporta `$0.000000` ya que no consume créditos de Gemini API con cobro por token.
