import os
import re
import json
import time
from urllib.parse import urlparse, parse_qs
from typing import Optional, Dict, Any

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
DB_FILE = os.path.join(DATA_DIR, "used_urls.json")
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")

_YOUTUBE_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
    "youtube-nocookie.com", "www.youtube-nocookie.com", "youtu.be"
}
_YT_ID_REGEX = re.compile(r"^[A-Za-z0-9_-]{11}$")

def extract_video_id(url: str) -> Optional[str]:
    """Extrae el ID único del video de YouTube (11 caracteres) si aplica."""
    try:
        u = urlparse(str(url or "").strip())
    except Exception:
        return None
    host = (u.hostname or "").lower()
    parts = [p for p in (u.path or "").split("/") if p]
    if host == "youtu.be":
        vid = parts[0] if parts else None
    elif host in _YOUTUBE_HOSTS:
        if parts[:1] == ["watch"]:
            vid = (parse_qs(u.query).get("v") or [None])[0]
        elif len(parts) >= 2 and parts[0] in ("shorts", "live", "embed", "v", "e"):
            vid = parts[1]
        elif len(parts) == 1 and _YT_ID_REGEX.match(parts[0]):
            vid = parts[0]
        else:
            vid = None
    else:
        vid = None
    return vid if vid and _YT_ID_REGEX.match(vid) else None

def normalize_key(url: str) -> str:
    """Genera una clave canónica para identificar unívocamente el recurso."""
    clean_url = str(url or "").strip()
    vid = extract_video_id(clean_url)
    if vid:
        return f"youtube:{vid}"
    
    # Para otras plataformas, normalizar quitando parámetros de tracking (utm, fbclid, si, etc.)
    try:
        u = urlparse(clean_url)
        host = (u.hostname or "").lower()
        path = u.path.rstrip("/")
        # Quitar parámetros comunes de tracking
        q = parse_qs(u.query)
        clean_q = {k: v for k, v in q.items() if not k.startswith("utm_") and k not in ("si", "fbclid", "igsh", "feature")}
        query_str = "&".join(f"{k}={v[0]}" for k, v in sorted(clean_q.items()))
        if query_str:
            return f"web:{host}{path}?{query_str}"
        return f"web:{host}{path}"
    except Exception:
        return f"raw:{clean_url.lower()}"

def _load_db() -> Dict[str, Any]:
    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(DB_FILE):
        return {}
    try:
        with open(DB_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def _save_db(data: Dict[str, Any]):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = DB_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, DB_FILE)

def record_url(url: str, job_id: str, title: str = "", clips_count: int = 0):
    """Guarda un registro de la URL asociada al job."""
    if not url:
        return
    db = _load_db()
    key = normalize_key(url)
    db[key] = {
        "url": url,
        "video_id": extract_video_id(url),
        "job_id": job_id,
        "title": title or "",
        "clips_count": clips_count,
        "date": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime()),
        "timestamp": time.time()
    }
    _save_db(db)

def update_job_info(job_id: str, title: str = "", clips_count: int = 0):
    """Actualiza el título y cantidad de clips de un job ya registrado."""
    db = _load_db()
    updated = False
    for key, item in db.items():
        if item.get("job_id") == job_id:
            if title and not item.get("title"):
                item["title"] = title
            if clips_count:
                item["clips_count"] = clips_count
            updated = True
    if updated:
        _save_db(db)

def get_title_quick(url: str) -> Optional[str]:
    """Obtiene rápidamente el título del video sin descargarlo."""
    try:
        import yt_dlp
        ydl_opts = {
            'quiet': True,
            'skip_download': True,
            'extract_flat': True,
            'no_warnings': True,
            'socket_timeout': 4
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            return info.get('title')
    except Exception:
        return None

def check_url(url: str) -> Dict[str, Any]:
    """
    Comprueba si una URL ya ha sido utilizada anteriormente.
    Devuelve dict con used: bool, y si es true, los metadatos del job anterior.
    """
    if not url or not url.strip():
        return {"used": False}

    db = _load_db()
    key = normalize_key(url)
    
    # 1. Búsqueda directa por clave canónica
    if key in db:
        item = db[key]
        job_id = item.get("job_id")
        job_dir = os.path.join(OUTPUT_DIR, job_id) if job_id else None
        
        if job_dir and os.path.isdir(job_dir):
            if not item.get("title") or not item.get("clips_count"):
                import glob
                meta_files = glob.glob(os.path.join(job_dir, "*_metadata.json"))
                if meta_files:
                    try:
                        with open(meta_files[0], "r", encoding="utf-8") as f:
                            mdata = json.load(f)
                        shorts = mdata.get("shorts", [])
                        item["clips_count"] = len(shorts)
                        if not item.get("title"):
                            item["title"] = os.path.basename(meta_files[0]).replace("_metadata.json", "").replace("_", " ")
                        _save_db(db)
                    except Exception:
                        pass

        return {
            "used": True,
            "job_id": item.get("job_id"),
            "title": item.get("title") or "Video procesado anteriormente",
            "date": item.get("date") or "",
            "clips_count": item.get("clips_count") or 0,
            "url": item.get("url") or url
        }

    # 2. Búsqueda por coincidencia de título con proyectos existentes en disco
    fetched_title = get_title_quick(url)
    if fetched_title:
        norm_fetched = re.sub(r'[^a-zA-Z0-9]', '', fetched_title).lower()
        import glob
        if os.path.isdir(OUTPUT_DIR):
            for entry in os.listdir(OUTPUT_DIR):
                job_dir = os.path.join(OUTPUT_DIR, entry)
                if not os.path.isdir(job_dir):
                    continue
                meta_files = glob.glob(os.path.join(job_dir, "*_metadata.json"))
                if not meta_files:
                    continue
                file_title = os.path.basename(meta_files[0]).replace("_metadata.json", "")
                norm_file = re.sub(r'[^a-zA-Z0-9]', '', file_title).lower()
                
                # Coincidencia si uno contiene al otro o son iguales
                if (norm_fetched and norm_file) and (norm_fetched in norm_file or norm_file in norm_fetched):
                    try:
                        with open(meta_files[0], "r", encoding="utf-8") as f:
                            mdata = json.load(f)
                        shorts = mdata.get("shorts", [])
                        mtime = os.path.getmtime(meta_files[0])
                        date_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(mtime))
                        
                        # Guardar la relación encontrada para acelerar futuras búsquedas
                        record = {
                            "url": url,
                            "video_id": extract_video_id(url),
                            "job_id": entry,
                            "title": fetched_title,
                            "clips_count": len(shorts),
                            "date": date_str,
                            "timestamp": mtime
                        }
                        db[key] = record
                        _save_db(db)
                        
                        return {
                            "used": True,
                            "job_id": entry,
                            "title": fetched_title,
                            "date": date_str,
                            "clips_count": len(shorts),
                            "url": url
                        }
                    except Exception:
                        pass

    return {"used": False}

def seed_from_existing_jobs():
    """
    Escanea la carpeta output/ para indexar proyectos ya existentes.
    """
    import glob
    db = _load_db()
    if not os.path.isdir(OUTPUT_DIR):
        return

    for entry in os.listdir(OUTPUT_DIR):
        job_dir = os.path.join(OUTPUT_DIR, entry)
        if not os.path.isdir(job_dir):
            continue
        meta_files = glob.glob(os.path.join(job_dir, "*_metadata.json"))
        if not meta_files:
            continue
        try:
            with open(meta_files[0], "r", encoding="utf-8") as f:
                data = json.load(f)
            title = os.path.basename(meta_files[0]).replace("_metadata.json", "").replace("_", " ")
            shorts = data.get("shorts", [])
            clips_count = len(shorts)
            mtime = os.path.getmtime(meta_files[0])
            date_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(mtime))
            
            # Verificar si este job_id ya está en db
            already_recorded = any(item.get("job_id") == entry for item in db.values())
            if not already_recorded:
                # Clave ficticia basada en el título limpio hasta que se vincule una URL
                clean_title_key = re.sub(r'[^a-zA-Z0-9]', '', title).lower()
                key = f"title:{clean_title_key}"
                db[key] = {
                    "url": "",
                    "video_id": None,
                    "job_id": entry,
                    "title": title,
                    "clips_count": clips_count,
                    "date": date_str,
                    "timestamp": mtime
                }
        except Exception:
            pass

    _save_db(db)
