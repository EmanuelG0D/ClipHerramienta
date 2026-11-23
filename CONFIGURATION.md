# Guía de Configuración de OpenShorts

Este documento detalla todas las opciones de configuración disponibles para proveedores de inteligencia artificial, transcripción, procesamiento de video y servicios adicionales.

---

## 1. Sistema Unificado de Proveedores de IA

OpenShorts soporta 4 proveedores de IA para el análisis de transcripciones y detección de momentos virales:

```
┌────────────────────────────────────────────────────────┐
│        SISTEMA DE SELECCIÓN DE PROVEEDORES IA          │
├───────────────────┬────────────────────────────────────┤
│ Google Antigravity│ CLI oficial `agy acp` (Gratis con  │
│ [Recomendado]     │ suscripción Antigravity / Google)  │
├───────────────────┼────────────────────────────────────┤
│ Gemini API        │ API oficial de Google Gemini       │
│                   │ (Requiere GEMINI_API_KEY)          │
├───────────────────┼────────────────────────────────────┤
│ Ollama            │ Modelos locales en tu propia GPU/  │
│                   │ CPU (Llama 3, Mistral, Qwen, etc.) │
├───────────────────┼────────────────────────────────────┤
│ LM Studio         │ Servidor local con modelos GGUF    │
│                   │ y compatibilidad OpenAI v1         │
└───────────────────┴────────────────────────────────────┘
```

---

## 2. Configuración por Proveedor

### A. Google Antigravity ACP (Recomendado)
- **Modo**: CLI oficial sobre stdio JSON-RPC 2.0.
- **Requiere API Key**: No. Utiliza la sesión activa del CLI `agy`.
- **Variables de entorno**:
  ```ini
  AI_PROVIDER=antigravity
  AI_MODEL=gemini-3.8-flash-high
  # Opcional: ruta personalizada al ejecutable agy
  AGY_CLI_PATH=C:\Users\<TU_USUARIO>\AppData\Local\agy\bin\agy.exe
  ```
- **Modelos soportados**:
  - `gemini-3.8-flash-high` (Por defecto)
  - `gemini-3.8-flash-medium`
  - `gemini-3.8-flash-low`
  - `claude-sonnet-4-6`
  - `claude-opus-4-6-thinking`
  - `gpt-oss-120b-medium`

### B. Google Gemini API
- **Modo**: Llamadas directas al SDK oficial `google-genai`.
- **Requiere API Key**: Sí (`GEMINI_API_KEY`).
- **Variables de entorno**:
  ```ini
  AI_PROVIDER=gemini
  GEMINI_API_KEY=AIzaSy...
  AI_MODEL=gemini-2.5-flash
  ```

### C. Ollama (100% Local y Offline)
- **Modo**: Endpoint REST local compatible con OpenAI API.
- **Requiere API Key**: No.
- **Variables de entorno**:
  ```ini
  AI_PROVIDER=ollama
  OLLAMA_BASE_URL=http://localhost:11434/v1
  AI_MODEL=llama3.2
  ```
- **Modelos sugeridos**: `llama3.2`, `mistral`, `qwen2.5-coder`.

### D. LM Studio
- **Modo**: Servidor local de LM Studio compatible con OpenAI API.
- **Requiere API Key**: No.
- **Variables de entorno**:
  ```ini
  AI_PROVIDER=lmstudio
  LM_STUDIO_BASE_URL=http://localhost:1234/v1
  AI_MODEL=default
  ```

---

## 3. Persistencia y Prioridad de Configuración

La configuración seleccionada por el usuario en la interfaz web se guarda automáticamente en el archivo:
```
ai_provider_config.json
```

### Orden de prioridad:
1. **Cabecera HTTP de la petición**: `X-AI-Provider` y `X-AI-Model` (permite enviar parámetros específicos por video).
2. **Archivo `ai_provider_config.json`**: Guarda la selección realizada desde el panel de control del Dashboard.
3. **Variables de Entorno (`.env`)**: `AI_PROVIDER`, `AI_MODEL`, `LLM_BASE_URL`.
4. **Valores por defecto del sistema**: Google Antigravity con `gemini-3.8-flash-high` si `agy` está disponible; de lo contrario Gemini API si existe `GEMINI_API_KEY`.

---

## 4. Configuración de Transcripción Local (Whisper)

OpenShorts utiliza `faster-whisper` para transcribir videos localmente sin costo de API externa:

```ini
# Tamaño del modelo Whisper a descargar automáticamente
# Opciones: tiny, base, small, medium, large-v3
WHISPER_MODEL=base

# Dispositivo de ejecución: 'cpu' o 'cuda' (si tienes NVIDIA)
WHISPER_DEVICE=cpu

# Tipo de precisión: 'int8' para CPU, 'float16' para GPU
WHISPER_COMPUTE_TYPE=int8
```

---

## 5. Configuración de Recorte y Seguimiento Facial

El seguimiento facial y reencuadre vertical 9:16 se ejecuta localmente mediante **MediaPipe** y recortes automáticos con **FFmpeg**:

- Si se detecta un solo orador, la cámara se centra dinámicamente en su rostro.
- Si se detectan dos oradores (formato podcast/entrevista), OpenShorts genera automáticamente una composición dividida (*split layout*), apilando a ambos oradores con subtítulos en la línea de corte.

---

## 6. Servicios Opcionales (No Obligatorios)

Ninguno de estos servicios es obligatorio para generar, editar o descargar clips:

| Servicio | Variable | Propósito | ¿Requerido? |
|---|---|---|---|
| **Upload-Post** | `UPLOAD_POST_API_KEY` | Publicación automática en TikTok, IG, YT | **Opcional** (Puedes descargar los videos manualmente) |
| **ElevenLabs** | `ELEVENLABS_API_KEY` | Voces sintetizadas para UGC | **Opcional** |
| **fal.ai** | `FAL_KEY` | Generación de avatares para UGC | **Opcional** |
| **Supabase** | `SUPABASE_URL` | Base de datos cloud para usuarios | **Opcional** (El modo auto-hospedado usa SQLite/memoria local) |
