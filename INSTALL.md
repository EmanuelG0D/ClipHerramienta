# Guía de Instalación desde Cero (Windows y Docker)

Esta guía explica paso a paso cómo instalar y ejecutar la versión personalizada de **OpenShorts + Google Antigravity ACP** en un entorno Windows 10/11 o mediante contenedores Docker.

---

## 1. Requisitos Previos del Sistema

### Hardware recomendado
- **CPU**: Procesador moderno multinúcleo (Intel Core i5/i7/i9 10ma gen+ o AMD Ryzen 5/7/9).
- **RAM**: 8 GB mínimo (16 GB recomendado para transcripción con Whisper y renderizado).
- **Disco**: Al menos 10 GB de espacio libre (para modelos Whisper, dependencias y videos temporales).
- **GPU (Opcional)**: NVIDIA con soporte CUDA acelera Whisper y renderizado, pero la aplicación funciona 100% en CPU.

### Software base necesario
1. **Python 3.10, 3.11 o 3.12** (con `pip` y agregado al PATH de Windows).
2. **Node.js 18+ y npm** (para compilar o ejecutar el dashboard React/Vite).
3. **FFmpeg y FFprobe** instalados y accesibles en el PATH de Windows.
4. **Git** para clonar y gestionar versiones.
5. **Google Antigravity CLI (`agy`)** instalado y autenticado (para usar el motor Antigravity sin costo adicional de API).
6. *(Opcional)* **Docker Desktop** (si prefieres ejecutar en contenedores).

---

## 2. Instalación de Herramientas Base en Windows

Abre PowerShell como Administrador o como usuario estándar:

### A. Instalar FFmpeg con winget
```powershell
winget install Gyan.FFmpeg
```
Verifica que funcione en una nueva consola:
```powershell
ffmpeg -version
ffprobe -version
```

### B. Instalar Node.js (si no lo tienes)
```powershell
winget install OpenJS.NodeJS.LTS
node -v
npm -v
```

### C. Instalar Python (si no lo tienes)
```powershell
winget install Python.Python.3.11
python --version
```

---

## 3. Instalación de Google Antigravity CLI (`agy`)

Para aprovechar tu suscripción/cuenta de Google Antigravity:

1. Instala el CLI oficial siguiendo las instrucciones de [Google Antigravity Docs](https://antigravity.google/docs/cli/install/).
2. Asegúrate de que el comando `agy` o la ruta `C:\Users\<TU_USUARIO>\AppData\Local\agy\bin\agy.exe` esté en tu PATH.
3. Inicia sesión con tu cuenta de Google:
   ```powershell
   agy auth login
   # o bien:
   agy acp --login
   ```
4. Comprueba el estado:
   ```powershell
   agy auth status
   ```
   Deberá mostrar `Logged in as: tu_correo@...` y tu plan (ej. *Google AI Pro*).

*(Consulta [ANTIGRAVITY_SETUP.md](file:///c:/Users/ehhig/Desktop/ClipsProyecto/ANTIGRAVITY_SETUP.md) para detalles avanzados sobre el protocolo ACP y modelos disponibles).*

---

## 4. Instalación de OpenShorts (Modo Nativo en Windows)

Este es el método más directo y recomendado en Windows, ya que permite comunicación directa stdio entre el backend de OpenShorts y `agy acp`.

### Paso 1: Clonar el repositorio y entrar
```powershell
cd c:\Users\<TU_USUARIO>\Desktop
git clone https://github.com/mutonby/openshorts ClipsProyecto
cd ClipsProyecto
```

### Paso 2: Crear el entorno virtual de Python
```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

### Paso 3: Instalar dependencias de Python
```powershell
pip install --upgrade pip
pip install -r requirements.txt
pip install opencv-python-headless pillow pydantic python-multipart boto3 beautifulsoup4
```

### Paso 4: Configurar variables de entorno (`.env`)
Copia el archivo de ejemplo o crea tu propio `.env`:
```powershell
cp .env.example .env
```
Edita `.env` con los valores mínimos:
```ini
# Configuración del servidor
PORT=8000
HOST=0.0.0.0

# Proveedor de Inteligencia Artificial
# Opciones: antigravity, gemini, ollama, lmstudio
AI_PROVIDER=antigravity
AI_MODEL=gemini-3.8-flash-high

# Si usas Antigravity, no necesitas GEMINI_API_KEY.
# Si quieres usar Gemini API directa como respaldo:
# GEMINI_API_KEY=tu_api_key_aqui

# Whisper local para transcripción gratuita
WHISPER_MODEL=base
```

### Paso 5: Instalar y compilar el Dashboard (Frontend)
```powershell
cd dashboard
npm install
npm run build
cd ..
```

### Paso 6: Iniciar la aplicación
Puedes iniciar el backend con FastAPI / Uvicorn:
```powershell
.\.venv\Scripts\python.exe -m uvicorn app:app --host 0.0.0.0 --port 8000 --reload
```
Abre tu navegador en:
```
http://localhost:8000
```
*(Si deseas ejecutar el frontend en modo desarrollo con recarga en vivo: en otra terminal `cd dashboard; npm run dev` y accede a `http://localhost:5173`).*

---

## 5. Instalación mediante Docker en Windows

Si prefieres ejecutar el backend en Docker:

### Arquitectura de Puente Host (Windows ↔ Docker)
En Windows, los contenedores Docker corren dentro de una máquina virtual WSL2 aislada y no tienen acceso directo a `agy.exe` ni al registro de Windows.

Para resolver esto sin exponer credenciales, OpenShorts incluye un puente seguro: **`antigravity_bridge.py`**:
- Se ejecuta en el host de Windows en `localhost:8001`.
- Expone un endpoint compatible con la API de completado estructurado.
- El contenedor Docker se comunica con él usando `http://host.docker.internal:8001/v1`.

### Paso 1: Iniciar el puente en Windows (Host)
```powershell
cd c:\Users\<TU_USUARIO>\Desktop\ClipsProyecto
.\.venv\Scripts\python.exe antigravity_bridge.py --host 0.0.0.0 --port 8001
```

### Paso 2: Configurar `.env` para Docker
```ini
AI_PROVIDER=antigravity
LLM_BASE_URL=http://host.docker.internal:8001/v1
```

### Paso 3: Levantar contenedores
```powershell
docker compose up -d --build
```
Accede a `http://localhost:8000`.

---

## 6. Verificación de la Instalación

Ejecuta el conjunto de pruebas automatizadas para confirmar que todo funciona correctamente:

```powershell
# Pruebas del adaptador Antigravity ACP
.\.venv\Scripts\python.exe -m pytest tests/test_antigravity_acp.py -v

# Pruebas del backend LLM multi-proveedor
.\.venv\Scripts\python.exe -m pytest tests/test_llm_backend.py -v

# Pruebas de selección de momentos
.\.venv\Scripts\python.exe -m pytest tests/test_clip_selection.py -v
```

¡Todo listo! Ya puedes procesar tus primeros videos y generar Shorts, Reels y TikToks de forma 100% gratuita y local.
