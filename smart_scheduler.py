import os
import json
import uuid
from datetime import datetime, timedelta, time as dtime
from typing import List, Dict, Any, Optional
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent / "data"
QUEUE_FILE = DATA_DIR / "schedule_queue.json"

# Horarios maestros óptimos para gaming y cobertura de toda Latinoamérica (UTC-5 / Colombia)
# 09:00 -> Colombia 9am, México 8am, Argentina 11am, España 3pm
# 11:30 -> Colombia 11:30am, México 10:30am, Argentina 1:30pm
# 14:00 -> Colombia 2pm, México 1pm, Argentina 4pm, España 8pm
# 17:00 -> Colombia 5pm, México 4pm, Argentina 7pm, España 11pm
# 19:45 -> Colombia 7:45pm, México 6:45pm, Argentina 9:45pm
# 22:00 -> Colombia 10pm, México 9pm, Argentina 12am
DEFAULT_SLOTS = ["09:00", "11:30", "14:00", "17:00", "19:45", "22:00"]

def ensure_data_dir():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not QUEUE_FILE.exists():
        initial = {
            "version": 1,
            "slots": DEFAULT_SLOTS,
            "queue": []
        }
        with open(QUEUE_FILE, "w", encoding="utf-8") as f:
            json.dump(initial, f, indent=2, ensure_ascii=False)

def load_queue() -> Dict[str, Any]:
    ensure_data_dir()
    try:
        with open(QUEUE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"version": 1, "slots": DEFAULT_SLOTS, "queue": []}

def save_queue(data: Dict[str, Any]):
    ensure_data_dir()
    with open(QUEUE_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

def get_next_available_slots(count: int, start_after: Optional[datetime] = None) -> List[datetime]:
    """
    Calcula los próximos N turnos disponibles respetando los horarios maestros.
    Si hoy ya pasaron algunos turnos o faltan menos de 25 minutos para el siguiente,
    salta al siguiente turno disponible de hoy o continúa mañana.
    """
    queue_data = load_queue()
    slots_str = queue_data.get("slots", DEFAULT_SLOTS)
    
    # Horas del día parseadas como objetos time
    parsed_slots = []
    for s in slots_str:
        parts = s.split(":")
        parsed_slots.append(dtime(hour=int(parts[0]), minute=int(parts[1])))
    parsed_slots.sort()

    # Obtener fechas/horas ya ocupadas en la cola (status != 'cancelled' y != 'failed')
    occupied_datetimes = set()
    for item in queue_data.get("queue", []):
        if item.get("status") in ["scheduled", "publishing", "published"]:
            dt_str = item.get("scheduled_datetime")
            if dt_str:
                try:
                    dt = datetime.fromisoformat(dt_str)
                    occupied_datetimes.add(dt.strftime("%Y-%m-%d %H:%M"))
                except ValueError:
                    pass

    now = datetime.now() if start_after is None else start_after
    # Meta requiere al menos 20 minutos en el futuro para programar
    min_future_time = now + timedelta(minutes=25)

    allocated_slots: List[datetime] = []
    current_date = now.date()

    # Buscar en un horizonte de hasta 30 días
    for day_offset in range(30):
        target_day = current_date + timedelta(days=day_offset)
        for slot_time in parsed_slots:
            slot_dt = datetime.combine(target_day, slot_time)
            
            # Si el slot ya quedó en el pasado o a menos de 25 min de 'now', lo saltamos
            if slot_dt < min_future_time:
                continue

            # Si ya hay un video asignado en este mismo minuto/horario, lo saltamos
            key = slot_dt.strftime("%Y-%m-%d %H:%M")
            if key in occupied_datetimes:
                continue

            allocated_slots.append(slot_dt)
            occupied_datetimes.add(key)

            if len(allocated_slots) >= count:
                return allocated_slots

    return allocated_slots

def plan_schedule_for_clips(clips: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Toma una lista de clips y les asigna su slot de publicación cronológico.
    Retorna la lista enriquecida con scheduled_datetime, display_date y display_time.
    """
    if not clips:
        return []

    slots = get_next_available_slots(len(clips))
    planned = []

    for idx, clip in enumerate(clips):
        target_dt = slots[idx] if idx < len(slots) else datetime.now() + timedelta(days=idx+1)
        
        # Formato legible en español
        meses = ["enero", "febrero", "marzo", "abril", "mayo", "junio", 
                 "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]
        dias_semana = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"]
        
        dia_nom = dias_semana[target_dt.weekday()]
        mes_nom = meses[target_dt.month - 1]
        
        display_date = f"{dia_nom} {target_dt.day} de {mes_nom}"
        display_time = target_dt.strftime("%I:%M %p")
        
        is_today = target_dt.date() == datetime.now().date()
        is_tomorrow = target_dt.date() == (datetime.now() + timedelta(days=1)).date()
        
        if is_today:
            tag = "Hoy"
        elif is_tomorrow:
            tag = "Mañana"
        else:
            tag = dia_nom

        item = {
            **clip,
            "scheduled_datetime": target_dt.isoformat(),
            "target_year": target_dt.year,
            "target_month": target_dt.month,
            "target_day": target_dt.day,
            "target_hour": target_dt.hour,
            "target_minute": target_dt.minute,
            "display_slot": f"{tag} {display_time}",
            "display_full": f"{display_date} a las {display_time}"
        }
        planned.append(item)

    return planned

def add_batch_to_queue(job_id: str, planned_clips: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Registra clips planificados en la cola persistente schedule_queue.json
    """
    queue_data = load_queue()
    items_added = []

    for clip in planned_clips:
        item_id = str(uuid.uuid4())
        record = {
            "id": item_id,
            "job_id": job_id,
            "clip_index": clip.get("clip_index") or clip.get("index") or 0,
            "video_url": clip.get("video_url") or clip.get("url") or "",
            "video_path": clip.get("video_path") or clip.get("path") or "",
            "title": clip.get("title") or clip.get("video_title_for_facebook") or clip.get("video_title_for_youtube_short") or clip.get("viral_hook_text") or clip.get("headline") or f"Clip #{clip.get('clip_index', 0) + 1}",
            "description": clip.get("description") or clip.get("video_description_for_facebook") or clip.get("video_description_for_tiktok") or clip.get("video_description_for_instagram") or clip.get("caption") or "",
            "scheduled_datetime": clip.get("scheduled_datetime"),
            "display_slot": clip.get("display_slot"),
            "status": "scheduled",  # scheduled, processing, published, failed
            "platform": "facebook",
            "created_at": datetime.now().isoformat(),
            "published_at": None,
            "error": None
        }
        queue_data["queue"].append(record)
        items_added.append(record)

    save_queue(queue_data)
    return items_added

def update_item_status(item_id: str, status: str, error: Optional[str] = None):
    queue_data = load_queue()
    for item in queue_data["queue"]:
        if item.get("id") == item_id:
            item["status"] = status
            if status == "published":
                item["published_at"] = datetime.now().isoformat()
            if error:
                item["error"] = error
            break
    save_queue(queue_data)

def get_queue_items(limit: int = 50) -> List[Dict[str, Any]]:
    queue_data = load_queue()
    items = queue_data.get("queue", [])
    # Ordenar por fecha programada
    items.sort(key=lambda x: x.get("scheduled_datetime", ""), reverse=False)
    return items[:limit]
