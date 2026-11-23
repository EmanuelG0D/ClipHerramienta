# Guía de Resolución de Problemas (Troubleshooting)

Esta guía cubre los errores más comunes y sus soluciones al ejecutar OpenShorts con Google Antigravity ACP, Whisper y FFmpeg en Windows o Docker.

---

## 1. Problemas con Google Antigravity CLI (`agy`)

### Error: `agy` no se reconoce como un comando interno o externo
**Causa**: El ejecutable `agy.exe` no se encuentra en la variable de entorno `PATH`.
**Solución**:
1. Comprueba si el archivo existe en:
   ```powershell
   Test-Path "$env:LOCALAPPDATA\agy\bin\agy.exe"
   ```
2. Si existe, agrega temporalmente o permanentemente la ruta a tu PATH:
   ```powershell
   $env:PATH += ";$env:LOCALAPPDATA\agy\bin"
   ```
3. O especifica la ruta explícita en tu archivo `.env`:
   ```ini
   AGY_CLI_PATH=C:\Users\<TU_USUARIO>\AppData\Local\agy\bin\agy.exe
   ```

---

### Error: `Estado: No autenticado` o `Sesión de Google expirada`
**Causa**: Las credenciales de la sesión de Google en el CLI de Antigravity han caducado.
**Solución**:
1. Puedes hacer clic en el botón **"Iniciar Sesión con Google"** en la interfaz web de OpenShorts.
2. O bien, ejecuta directamente en tu terminal:
   ```powershell
   agy auth login
   # o:
   agy acp --login
   ```
3. Completa la autenticación en la ventana de navegador que se abrirá automáticamente.
4. Verifica con:
   ```powershell
   agy auth status
   ```

---

### Error: `Tiempo de espera agotado al conectar con Antigravity ACP`
**Causa**: El subproceso `agy acp --stdio` no respondió al handshake JSON-RPC en el tiempo límite (60 segundos).
**Solución**:
1. Comprueba manualmente que el comando responde:
   ```powershell
   agy acp --help
   ```
2. Si el proceso quedó bloqueado en segundo plano, ciérralo con PowerShell:
   ```powershell
   Get-Process agy -ErrorAction SilentlyContinue | Stop-Process -Force
   ```
3. El cliente `antigravity_acp.py` de OpenShorts incluye reconexión automática y fallback a CLI directo en caso de desconexión del socket stdio.

---

### Error en Docker: `No se puede conectar a agy desde el contenedor`
**Causa**: Los contenedores Docker en Windows corren dentro de WSL2 y no tienen acceso a los ejecutables `.exe` ni a las credenciales locales de Windows.
**Solución**:
1. Ejecuta el puente de Antigravity en la máquina host de Windows:
   ```powershell
   .\.venv\Scripts\python.exe antigravity_bridge.py --host 0.0.0.0 --port 8001
   ```
2. Asegúrate de que `docker-compose.yml` contenga `extra_hosts`:
   ```yaml
   extra_hosts:
     - "host.docker.internal:host-gateway"
   ```
3. Configura en tu archivo `.env`:
   ```ini
   LLM_BASE_URL=http://host.docker.internal:8001/v1
   ```

---

## 2. Problemas con FFmpeg y Renderizado

### Error: `FileNotFoundError: [Errno 2] No such file or directory: 'ffmpeg'`
**Causa**: FFmpeg no está instalado o no se encuentra en el PATH del sistema.
**Solución**:
1. Instala FFmpeg mediante `winget`:
   ```powershell
   winget install Gyan.FFmpeg
   ```
2. Cierra y vuelve a abrir la terminal de PowerShell para recargar las variables de entorno.
3. Verifica con:
   ```powershell
   ffmpeg -version
   ffprobe -version
   ```

---

## 3. Problemas con Python y Dependencias en Windows

### Error: `Filename too long` al instalar dependencias con pip
**Causa**: El límite histórico de 260 caracteres en rutas de Windows (`MAX_PATH`).
**Solución**:
1. Habilita rutas largas en Windows ejecutando PowerShell como Administrador:
   ```powershell
   New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force
   ```
2. O utiliza una ruta corta para el entorno virtual, como `C:\Users\<USUARIO>\Desktop\ClipsProyecto\.venv`.

---

### Error: `ModuleNotFoundError: No module named 'fcntl'`
**Causa**: `fcntl` es una librería exclusiva de sistemas operativos tipo Unix (Linux/macOS).
**Solución**:
- Esta versión personalizada incluye automáticamente shims y bloqueos de archivos multiplataforma (`_FcntlShim` en `remote_worker.py`, `source_cache.py` y `yt_account.py`), por lo que el proyecto funciona sin modificaciones en Windows.

---

## 4. Problemas con la Detección de Momentos Virales

### El análisis termina con 0 clips detectados
**Causas posibles**:
1. El video es demasiado corto (menos de 60 segundos) o no contiene voz detectable.
2. El audio tiene música de fondo muy alta y Whisper no pudo generar una transcripción con marcas de tiempo.
3. El modelo de IA filtró todas las ventanas porque ninguna superó el umbral de interés.

**Solución**:
1. Comprueba que el archivo de audio o subtítulos contenga texto válido.
2. Si estás usando videos en idiomas distintos al inglés o español, especifica el idioma en la petición o selecciona un modelo Whisper más grande (`WHISPER_MODEL=small` o `medium`).
3. Prueba con otro modelo de razonamiento en el selector (ej. cambiar entre `gemini-3.8-flash-high` y `claude-sonnet-4-6`).

---

## 5. Puerto Ocupado (Error 8000 o 5173 en uso)

Si al iniciar Uvicorn o Vite recibes `error: [Errno 10048] address already in use`:
```powershell
# Encontrar proceso ocupando el puerto 8000
netstat -ano | findstr :8000

# Terminar el proceso por PID
taskkill /F /PID <PID_NUMERO>
```
O arranca Uvicorn en otro puerto:
```powershell
.\.venv\Scripts\python.exe -m uvicorn app:app --port 8080
```
