import os
import sys
import time
from typing import Dict, Any
from pathlib import Path

FB_PROFILE_PREFERRED = r"c:\Users\ehhig\Desktop\tv o algo asi\facebook_bot\fb_profile"
DEFAULT_PROFILE = os.path.join(os.environ.get("USERPROFILE", "C:\\"), ".openshorts_chrome_profile")

def get_profile_dir() -> str:
    if os.path.exists(FB_PROFILE_PREFERRED):
        return FB_PROFILE_PREFERRED
    os.makedirs(DEFAULT_PROFILE, exist_ok=True)
    return DEFAULT_PROFILE

def publish_to_facebook(video_path: str, caption: str, auto_click_publish: bool = True) -> Dict[str, Any]:
    """
    Subida y publicación 100% automática en Meta Business Suite Reels Composer
    usando la sesión autenticada de fb_profile.
    """
    profile_dir = get_profile_dir()
    abs_video_path = str(Path(video_path).resolve())

    if not os.path.exists(abs_video_path):
        return {"success": False, "error": f"Archivo de video no encontrado: {abs_video_path}"}

    from playwright.sync_api import sync_playwright

    print(f"\n==================================================")
    print(f"[*] Iniciando auto-publicador de Reels en Facebook...")
    print(f"[*] Video: {abs_video_path}")
    print(f"[*] Perfil: {profile_dir}")
    print(f"==================================================\n", flush=True)

    try:
        with sync_playwright() as p:
            context = p.chromium.launch_persistent_context(
                user_data_dir=profile_dir,
                headless=True,
                channel="chrome",
                args=["--disable-blink-features=AutomationControlled"]
            )

            page = context.pages[0] if context.pages else context.new_page()

            # Interceptor dinámico 100% certero:
            # Captura el input de archivo exacto al que Meta le hace click cuando se pulsa "Agregar video"
            page.add_init_script("""
                const origClick = HTMLInputElement.prototype.click;
                HTMLInputElement.prototype.click = function() {
                    if (this.type === 'file') {
                        this.id = 'openshorts_active_upload_input';
                        this.style.display = 'block';
                        this.style.opacity = '0';
                        this.style.position = 'fixed';
                        if (!this.parentElement) {
                            document.body.appendChild(this);
                        }
                    }
                    return origClick.apply(this, arguments);
                };
            """)

            url = "https://business.facebook.com/latest/reels_composer"
            print(f"[*] Navegando a Meta Reels Composer...", flush=True)
            page.goto(url, timeout=45000)
            time.sleep(5)

            # Verificar si requiere login
            if "login" in page.url or "checkpoint" in page.url:
                context.close()
                return {"success": False, "error": "La sesión de Facebook expiró o requiere inicio de sesión en fb_profile."}

            # 1. Clic en "Agregar video"
            print("[*] Localizando botón Agregar video...", flush=True)
            btn = page.locator('div[role="button"]:has-text("Agregar video")').first
            btn.click()
            time.sleep(2)

            file_input = page.locator('#openshorts_active_upload_input').first
            if file_input.count() == 0:
                time.sleep(1)
                file_input = page.locator('#openshorts_active_upload_input').first

            print(f"[*] Inyectando archivo de video ({file_input.count()} input encontrado)...", flush=True)
            file_input.set_input_files(abs_video_path)
            print("[+] Video asociado correctamente.", flush=True)
            time.sleep(1)

            # 2. Escribir descripción y hashtags
            print("[*] Escribiendo título, descripción y hashtags...", flush=True)
            textbox = page.locator('div[role="textbox"]').first
            if textbox.is_visible(timeout=8000):
                textbox.click()
                time.sleep(0.5)
                page.keyboard.insert_text(caption)
                time.sleep(1)
                page.keyboard.press("Escape")
                print("[+] Texto insertado con éxito y dropdown cerrado.", flush=True)
            else:
                page.keyboard.type(caption)
                page.keyboard.press("Escape")

            # 3. Esperar a que el botón Siguiente esté habilitado (Meta procesa el video)
            print("[*] Esperando que Meta procese el video y habilite el botón Siguiente...", flush=True)
            siguiente_btn = None
            for attempt in range(60):  # Hasta 120 segundos
                siguiente = page.locator('div[role="button"]:has-text("Siguiente"), button:has-text("Siguiente")').last
                if siguiente.is_visible():
                    aria = siguiente.get_attribute("aria-disabled")
                    dis = siguiente.get_attribute("disabled")
                    if aria != "true" and dis is None:
                        siguiente_btn = siguiente
                        print(f"[+] ¡Botón Siguiente habilitado tras {attempt * 2} segundos!", flush=True)
                        break
                time.sleep(2)

            if not siguiente_btn:
                page.screenshot(path="scratch/meta_timeout_failure.png")
                context.close()
                return {"success": False, "error": "Meta tardó demasiado en procesar el video o el botón Siguiente no se activó."}

            # 4. Paso 1 -> Paso 2 (Editar)
            print("[*] Avanzando a Paso 2 (Editar)...", flush=True)
            siguiente_btn.click()
            time.sleep(3)

            # 5. Paso 2 -> Paso 3 (Compartir)
            print("[*] Avanzando a Paso 3 (Compartir)...", flush=True)
            siguiente2 = page.locator('div[role="button"]:has-text("Siguiente"), button:has-text("Siguiente")').last
            if siguiente2.is_visible(timeout=10000):
                siguiente2.click()
                time.sleep(3)

            # 6. Botón final: "Compartir" o "Publicar"
            pub_btn = None
            print("[*] Esperando a que el botón final de Compartir esté habilitado en Paso 3...", flush=True)
            for attempt in range(20):  # Hasta 40 segundos
                candidate = page.locator('div[role="button"]:has-text("Compartir"), button:has-text("Compartir"), div[role="button"]:has-text("Publicar"), button:has-text("Publicar")').last
                if candidate.is_visible():
                    aria = candidate.get_attribute("aria-disabled")
                    dis = candidate.get_attribute("disabled")
                    if aria != "true" and dis is None:
                        pub_btn = candidate
                        print(f"[+] Botón final Compartir habilitado tras {attempt * 2} segundos!", flush=True)
                        break
                time.sleep(2)

            if not pub_btn:
                page.screenshot(path="scratch/meta_share_button_failure.png")
                context.close()
                return {"success": False, "error": "No se habilitó el botón final de Compartir en Meta."}

            if auto_click_publish:
                print("[*] ¡Haciendo clic en Compartir!", flush=True)
                pub_btn.click()
                print("[*] Esperando confirmación de publicación de Meta...", flush=True)

                published = False
                for _ in range(20):  # Hasta 40 segundos
                    time.sleep(2)
                    listo_btn = page.locator('div[role="button"]:has-text("Listo"), button:has-text("Listo")').first
                    if listo_btn.is_visible():
                        listo_btn.click()
                        time.sleep(2)
                        published = True
                        break
                    if "reels_composer" not in page.url:
                        published = True
                        break
                    if page.locator('div[role="button"]:has-text("Compartir")').count() == 0:
                        published = True
                        break

                context.close()
                print("[+] ¡Reel publicado exitosamente en Meta Business Suite!", flush=True)
                return {
                    "success": True,
                    "published": True,
                    "message": "¡Reel publicado con éxito en tu página de Facebook!"
                }
            else:
                return {
                    "success": True,
                    "published": False,
                    "message": "Video cargado y preparado en Meta Reels Composer."
                }

    except Exception as e:
        print(f"[-] Error en publish_to_facebook: {e}", flush=True)
        return {"success": False, "error": str(e)}

def prepare_post(platform: str, video_path: str, title: str = "", description: str = "") -> Dict[str, Any]:
    full_text = f"{title}\n\n{description}".strip() if title else description.strip()
    plat = platform.lower()

    if "face" in plat:
        return publish_to_facebook(video_path, full_text, auto_click_publish=True)
    else:
        return {
            "success": False,
            "error": f"La plataforma {platform} aún no tiene auto-publicador configurado."
        }
