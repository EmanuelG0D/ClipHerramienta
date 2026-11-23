import React, { useState, useEffect, useRef } from 'react';
import { Link2, Upload, FileVideo, X, Info, Loader2, ChevronDown, Scissors, AlertTriangle, Eye, RefreshCw } from 'lucide-react';
import { track } from '../lib/analytics';
import { getApiUrl } from '../config';
import SourceCost from './SourceCost';

const SUPPORTED_PLATFORMS = [
    'YouTube', 'Vimeo', 'TikTok', 'X / Twitter', 'Twitch', 'Kick',
    'Facebook', 'Instagram', 'Dailymotion', 'Reddit', 'Streamable',
];

// Mirrors the server's MIN_SOURCE_SECONDS: shorter sources are rejected with a
// 400 after the whole file was uploaded. Checking the duration in the browser
// says so the moment the file is picked (a 27 s upload used to end in a bare
// "That run failed").
const MIN_SOURCE_SECONDS = 45;

// Duration of a local video file in seconds, or null when the browser cannot
// read it (unsupported codec): then the server stays the judge.
const readVideoDuration = (file) => new Promise((resolve) => {
    try {
        const url = URL.createObjectURL(file);
        const v = document.createElement('video');
        v.preload = 'metadata';
        const done = (d) => { URL.revokeObjectURL(url); resolve(d); };
        v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null);
        v.onerror = () => done(null);
        setTimeout(() => done(null), 8000);
        v.src = url;
    } catch { resolve(null); }
});

export default function MediaInput({ onProcess, isProcessing, onViewJob }) {
    const [youtubeUrlEnabled, setYoutubeUrlEnabled] = useState(true);
    // File upload is the primary path; the link is secondary.
    const [mode, setMode] = useState('file'); // 'file' | 'url'
    const [url, setUrl] = useState('');
    const [file, setFile] = useState(null);
    const [fileSeconds, setFileSeconds] = useState(null);
    const fileTooShort = fileSeconds != null && fileSeconds < MIN_SOURCE_SECONDS;
    const [acknowledged, setAcknowledged] = useState(false);
    // {start, end} in seconds when the user picked a stretch under the cost line.
    const [range, setRange] = useState(null);
    const [outputFormat, setOutputFormat] = useState('vertical'); // vertical | horizontal | square
    const [showInfo, setShowInfo] = useState(false);

    // Estado para detección de URLs repetidas
    const [usedUrlInfo, setUsedUrlInfo] = useState(null);
    const [showUsedModal, setShowUsedModal] = useState(false);
    const [checkingUrl, setCheckingUrl] = useState(false);
    // Advanced generation controls — empty string means "let the AI decide",
    // which keeps the default pipeline behavior untouched.
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [targetClips, setTargetClips] = useState('');
    const [clipMinSeconds, setClipMinSeconds] = useState('');
    const [clipMaxSeconds, setClipMaxSeconds] = useState('');
    // Auto-hook: burn the AI hook text into every clip. On by default; the
    // choice persists so turning it off sticks across sessions.
    const [autoHook, setAutoHook] = useState(() => {
        try { return localStorage.getItem('os_auto_hook') !== '0'; } catch { return true; }
    });
    const [autoHookStyle, setAutoHookStyle] = useState(() => {
        // v2 key: the default became 'pill'; an old saved 'classic' was just the old default.
        try { return localStorage.getItem('os_auto_hook_style_v2') || 'pill'; } catch { return 'pill'; }
    });
    // Layout: 'auto' lets the AI pick per video (server default); the others
    // force one on so a podcast host who knows what they uploaded doesn't
    // depend on the detector, and 'none' keeps the plain single crop.
    const [layout, setLayout] = useState(() => {
        try { return localStorage.getItem('os_layout') || 'auto'; } catch { return 'auto'; }
    });

    // Time-range partial extraction presets & state
    const [rangePreset, setRangePreset] = useState('all');
    const [rangeStartMin, setRangeStartMin] = useState('');
    const [rangeEndMin, setRangeEndMin] = useState('');

    const applyRangePreset = (preset) => {
        setRangePreset(preset);
        if (preset === 'all') {
            setRangeStartMin('');
            setRangeEndMin('');
            setRange(null);
        } else if (preset === 'first_30') {
            setRangeStartMin('0');
            setRangeEndMin('30');
            setRange({ start: 0, end: 30 * 60 });
        } else if (preset === 'first_60') {
            setRangeStartMin('0');
            setRangeEndMin('60');
            setRange({ start: 0, end: 60 * 60 });
        } else if (preset === 'first_90') {
            setRangeStartMin('0');
            setRangeEndMin('90');
            setRange({ start: 0, end: 90 * 60 });
        } else if (preset === 'second_hour') {
            setRangeStartMin('60');
            setRangeEndMin('120');
            setRange({ start: 60 * 60, end: 120 * 60 });
        } else if (preset === 'custom') {
            const s = rangeStartMin !== '' ? Math.max(0, parseFloat(rangeStartMin) || 0) : 0;
            const e = rangeEndMin !== '' ? Math.max(0, parseFloat(rangeEndMin) || 0) : null;
            if (s > 0 || (e != null && e > 0)) {
                setRange({ start: s * 60, end: (e != null && e > 0) ? e * 60 : null });
            } else {
                setRange(null);
            }
        }
    };

    const handleCustomRangeChange = (newStart, newEnd) => {
        setRangeStartMin(newStart);
        setRangeEndMin(newEnd);
        setRangePreset('custom');
        const s = newStart !== '' ? Math.max(0, parseFloat(newStart) || 0) : 0;
        const e = newEnd !== '' ? Math.max(0, parseFloat(newEnd) || 0) : null;
        if (s > 0 || (e != null && e > 0)) {
            setRange({ start: s * 60, end: (e != null && e > 0) ? e * 60 : null });
        } else {
            setRange(null);
        }
    };
    const infoRef = useRef(null);

    // Close the compatibility popover on any outside click.
    useEffect(() => {
        if (!showInfo) return;
        const onClick = (e) => {
            if (infoRef.current && !infoRef.current.contains(e.target)) setShowInfo(false);
        };
        document.addEventListener('mousedown', onClick);
        return () => document.removeEventListener('mousedown', onClick);
    }, [showInfo]);

    useEffect(() => {
        let cancelled = false;
        setFileSeconds(null);
        if (!file) return undefined;
        readVideoDuration(file).then((d) => {
            if (cancelled) return;
            setFileSeconds(d);
            if (d != null && d < MIN_SOURCE_SECONDS) {
                track('SourceTooShort', { props: { seconds: String(Math.round(d)) } });
            }
        });
        return () => { cancelled = true; };
    }, [file]);

    useEffect(() => {
        fetch(getApiUrl('/api/config'))
            .then((r) => r.ok ? r.json() : null)
            .then((cfg) => {
                if (cfg && cfg.youtubeUrlEnabled === false) {
                    setYoutubeUrlEnabled(false);
                    setMode('file');
                }
            })
            .catch(() => {});
    }, []);

    // A link pasted in the landing hero: preload it here so the user picks up
    // where they left off. Not auto-submitted — the rights attestation below
    // has to be ticked by the user.
    useEffect(() => {
        let pending = null;
        try {
            pending = localStorage.getItem('os_pending_url');
            if (pending) localStorage.removeItem('os_pending_url');
        } catch { /* ignore */ }
        if (pending) {
            setMode('url');
            setUrl(pending);
        }
    }, []);

    // Verificación automática en segundo plano de enlaces ya procesados
    useEffect(() => {
        if (mode !== 'url' || !url || url.trim().length < 10) {
            setUsedUrlInfo(null);
            return;
        }
        let active = true;
        const timer = setTimeout(async () => {
            try {
                const res = await fetch(getApiUrl(`/api/check-url?url=${encodeURIComponent(url.trim())}`));
                if (!res.ok) return;
                const data = await res.json();
                if (active) {
                    setUsedUrlInfo(data?.used ? data : null);
                }
            } catch {
                if (active) setUsedUrlInfo(null);
            }
        }, 500);
        return () => { active = false; clearTimeout(timer); };
    }, [url, mode]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!acknowledged) return;
        const advanced = {
            targetClips: targetClips || null,
            clipMinSeconds: clipMinSeconds || null,
            clipMaxSeconds: clipMaxSeconds || null,
            autoHook,
            autoHookStyle,
            layout,
            sourceStart: (range && range.start != null) ? Math.round(range.start) : null,
            sourceEnd: (range && range.end != null) ? Math.round(range.end) : null,
        };
        try {
            localStorage.setItem('os_auto_hook', autoHook ? '1' : '0');
            localStorage.setItem('os_auto_hook_style_v2', autoHookStyle);
            localStorage.setItem('os_layout', layout);
        } catch { /* ignore */ }

        if (mode === 'url' && url) {
            let info = usedUrlInfo;
            if (!info) {
                setCheckingUrl(true);
                try {
                    const res = await fetch(getApiUrl(`/api/check-url?url=${encodeURIComponent(url.trim())}`));
                    if (res.ok) {
                        const data = await res.json();
                        if (data?.used) {
                            info = data;
                            setUsedUrlInfo(data);
                        }
                    }
                } catch { /* ignore */ }
                setCheckingUrl(false);
            }

            // Si el enlace ya se utilizó, abrir aviso/modal de confirmación
            if (info && info.used) {
                setShowUsedModal(true);
                return;
            }

            onProcess({ type: 'url', payload: url, acknowledged: true, outputFormat, ...advanced });
        } else if (mode === 'file' && file && !fileTooShort) {
            onProcess({ type: 'file', payload: file, acknowledged: true, outputFormat, ...advanced });
        }
    };

    const handleDrop = (e) => {
        e.preventDefault();
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            setFile(e.dataTransfer.files[0]);
            setMode('file');
        }
    };

    return (
        <div className="card p-4 sm:p-6 animate-fade">
            <div className="flex gap-4 sm:gap-6 mb-6 border-b border-rule" data-tutorial="source-tabs">
                <button
                    onClick={() => setMode('file')}
                    className={`flex items-center gap-2 pb-3 px-1 -mb-px border-b-2 text-sm lowercase whitespace-nowrap transition-colors ${mode === 'file'
                        ? 'text-ink border-brass'
                        : 'text-muted border-transparent hover:text-ink2'
                        }`}
                >
                    <Upload size={16} className={`hidden sm:block ${mode === 'file' ? 'text-brass' : ''}`} />
                    Subir Archivo
                </button>
                {youtubeUrlEnabled && (
                    <button
                        onClick={() => setMode('url')}
                        className={`flex items-center gap-2 pb-3 px-1 -mb-px border-b-2 text-sm lowercase whitespace-nowrap transition-colors ${mode === 'url'
                            ? 'text-ink border-brass'
                            : 'text-muted border-transparent hover:text-ink2'
                            }`}
                    >
                        <Link2 size={16} className={`hidden sm:block ${mode === 'url' ? 'text-brass' : ''}`} />
                        Enlace de Video
                    </button>
                )}
            </div>

            <form onSubmit={handleSubmit}>
                {mode === 'url' ? (
                    <div className="space-y-4" data-tutorial="drop-zone">
                        <div className="relative">
                            <input
                                type="url"
                                value={url}
                                onChange={(e) => setUrl(e.target.value)}
                                placeholder="https://... pega el enlace del video"
                                className="input-field pr-11"
                                required
                            />
                            <div className="absolute inset-y-0 right-2 flex items-center" ref={infoRef}>
                                <button
                                    type="button"
                                    onClick={() => setShowInfo((v) => !v)}
                                    aria-label="Plataformas soportadas"
                                    className="p-1.5 text-muted hover:text-brass transition-colors"
                                >
                                    <Info size={16} />
                                </button>
                                {showInfo && (
                                    <div className="absolute right-0 top-full mt-2 w-64 z-20 card p-4 text-left animate-fade">
                                        <p className="eyebrow mb-2">Pega un enlace de</p>
                                        <div className="flex flex-wrap gap-1.5">
                                            {SUPPORTED_PLATFORMS.map((p) => (
                                                <span key={p} className="text-xs px-2 py-0.5 rounded-full bg-paper3 text-ink2">
                                                    {p}
                                                </span>
                                            ))}
                                        </div>
                                        <p className="text-xs text-muted mt-2.5 leading-relaxed">
                                            …y más de 1.000 sitios. Si el video es público, se puede procesar directamente.
                                        </p>
                                    </div>
                                )}
                            </div>
                        </div>

                        {usedUrlInfo && (
                            <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-left text-xs space-y-2 animate-fade">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-1.5 text-amber-400 font-medium">
                                        <AlertTriangle size={15} />
                                        <span>⚠️ Este enlace ya fue utilizado anteriormente</span>
                                    </div>
                                    {onViewJob && usedUrlInfo.job_id && (
                                        <button
                                            type="button"
                                            onClick={() => onViewJob(usedUrlInfo.job_id)}
                                            className="px-2.5 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 rounded font-medium text-xs transition-colors flex items-center gap-1"
                                        >
                                            <Eye size={12} />
                                            Ver clips existentes →
                                        </button>
                                    )}
                                </div>
                                <p className="text-ink/80 text-xs truncate">
                                    <strong>Video:</strong> {usedUrlInfo.title || 'Video procesado'}
                                </p>
                                <p className="text-muted text-[11px]">
                                    {usedUrlInfo.date ? `Fecha: ${usedUrlInfo.date}` : ''} {usedUrlInfo.clips_count ? ` · ${usedUrlInfo.clips_count} clips disponibles` : ''}
                                </p>
                            </div>
                        )}
                    </div>
                ) : (
                    <div
                        data-tutorial="drop-zone"
                        className={`border-2 border-dashed rounded-card p-6 sm:p-8 text-center transition-colors ${file ? 'border-brass' : 'border-rule2 hover:border-brass'
                            }`}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={handleDrop}
                    >
                        {file ? (
                            <div className="flex items-center justify-center gap-3 text-ok min-w-0">
                                <FileVideo size={18} className="shrink-0" />
                                <span className="font-medium truncate">{file.name}</span>
                                <button
                                    type="button"
                                    onClick={() => setFile(null)}
                                    className="p-1 text-muted hover:text-ink hover:bg-paper3 rounded-full transition-colors"
                                >
                                    <X size={16} />
                                </button>
                            </div>
                        ) : null}
                        {file && fileTooShort ? (
                            <p className="text-danger text-sm mt-3" role="alert">
                                Este video dura {Math.round(fileSeconds)}s. La generación necesita al menos {MIN_SOURCE_SECONDS}s
                                de material: ya es un video corto. Elige un video más largo.
                            </p>
                        ) : null}
                        {!file && (
                            <label className="cursor-pointer block">
                                <input
                                    type="file"
                                    accept="video/*"
                                    onChange={(e) => setFile(e.target.files?.[0] || null)}
                                    className="hidden"
                                />
                                <Upload className="mx-auto mb-3 text-muted" size={18} />
                                <p className="text-ink2 lowercase">Haz clic para subir o arrastra y suelta aquí</p>
                                <p className="readout mt-2">MP4, MOV hasta 500MB · al menos {MIN_SOURCE_SECONDS}s de duración</p>
                            </label>
                        )}
                    </div>
                )}

                <SourceCost
                    mode={mode}
                    url={url}
                    fileSeconds={fileSeconds}
                    range={range}
                    onRangeChange={setRange}
                />

                {/* Output format selector */}
                <div className="mt-5" data-tutorial="output-format">
                    <p className="eyebrow mb-2">Formato de salida</p>
                    <div className="grid grid-cols-3 gap-2">
                        {[
                            { value: 'vertical', label: '9:16', hint: 'Shorts · Reels · TikTok', w: 18, h: 32 },
                            { value: 'square', label: '1:1', hint: 'Publicaciones de feed', w: 28, h: 28 },
                            { value: 'horizontal', label: '16:9', hint: 'Mantener horizontal · YouTube', w: 36, h: 20 },
                        ].map((f) => {
                            const active = outputFormat === f.value;
                            return (
                                <button
                                    key={f.value}
                                    type="button"
                                    onClick={() => setOutputFormat(f.value)}
                                    className={`py-3 px-2 rounded-input border flex flex-col items-center gap-2 transition-colors
                                        ${active ? 'border-[color:var(--color-accent)] text-ink' : 'border-rule2 text-muted hover:border-[color:var(--color-accent)]'}`}
                                >
                                    {/* Aspect-ratio glyph */}
                                    <span
                                        className="rounded-[3px] border-2 transition-colors"
                                        style={{
                                            width: `${f.w}px`,
                                            height: `${f.h}px`,
                                            borderColor: active ? 'var(--color-accent)' : 'var(--color-rule-2)',
                                            backgroundColor: active ? 'color-mix(in srgb, var(--color-accent) 22%, transparent)' : 'transparent',
                                        }}
                                    />
                                    <span className="block font-mono text-sm leading-none">{f.label}</span>
                                    <span className="block text-[11px] sm:text-[10px] leading-tight text-center text-muted">{f.hint}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* Advanced generation controls — collapsed by default; blank = AI decides */}
                <div className="mt-4">
                    <button
                        type="button"
                        onClick={() => setShowAdvanced((v) => !v)}
                        className="flex items-center gap-1.5 text-xs text-muted hover:text-ink2 lowercase transition-colors"
                    >
                        <ChevronDown size={14} className={`transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
                        opciones avanzadas
                        {(targetClips || clipMinSeconds || clipMaxSeconds || !autoHook || rangePreset !== 'all' || layout !== 'auto') && (
                            <span className="text-brass">·</span>
                        )}
                    </button>
                    {showAdvanced && (
                        /* Stacked on a phone: three number fields side by side leaves
                           ~100px each, which crushes both label and value. */
                        <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-2 animate-fade">
                            <div>
                                <p className="eyebrow mb-1.5">cantidad de clips</p>
                                <input
                                    type="number" min="1" max="15" step="1"
                                    value={targetClips}
                                    onChange={(e) => setTargetClips(e.target.value)}
                                    placeholder="auto (3)"
                                    className="input-field"
                                />
                            </div>
                            <div>
                                <p className="eyebrow mb-1.5">duración mín. (s)</p>
                                <input
                                    type="number" min="5" max="175" step="1"
                                    value={clipMinSeconds}
                                    onChange={(e) => setClipMinSeconds(e.target.value)}
                                    placeholder="20"
                                    className="input-field"
                                />
                            </div>
                            <div>
                                <p className="eyebrow mb-1.5">duración máx. (s)</p>
                                <input
                                    type="number" min="10" max="180" step="1"
                                    value={clipMaxSeconds}
                                    onChange={(e) => setClipMaxSeconds(e.target.value)}
                                    placeholder="55"
                                    className="input-field"
                                />
                            </div>
                            <p className="col-span-1 sm:col-span-3 text-[11px] leading-relaxed text-muted">
                                Objetivos sugeridos: la IA selecciona los momentos que tengan verdadero potencial viral.
                            </p>
                            <div className="col-span-1 sm:col-span-3 flex flex-wrap items-center justify-between gap-3 pt-3 sm:pt-1 border-t border-rule">
                                <span className="text-xs text-ink2">diseño vertical</span>
                                <select
                                    value={layout}
                                    onChange={(e) => setLayout(e.target.value)}
                                    className="input-field !w-auto text-xs py-1.5"
                                    aria-label="diseño vertical"
                                >
                                    <option value="auto">Automático (la IA elige por escena)</option>
                                    <option value="split">Dos personas divididas (split)</option>
                                    <option value="screencast">Pantalla sobre presentador</option>
                                    <option value="none">Encuadre simple centrado</option>
                                </select>
                            </div>
                            <div className="col-span-1 sm:col-span-3 flex flex-wrap items-center justify-between gap-3 pt-3 sm:pt-1 border-t border-rule">
                                <label className="flex items-center gap-2 text-xs text-ink2 cursor-pointer select-none">
                                    <input
                                        type="checkbox"
                                        checked={autoHook}
                                        onChange={(e) => setAutoHook(e.target.checked)}
                                        className="w-4 h-4 shrink-0 accent-[var(--color-accent)] cursor-pointer"
                                    />
                                    generar ganchos de texto automáticos
                                </label>
                                {autoHook && (
                                    <select
                                        value={autoHookStyle}
                                        onChange={(e) => setAutoHookStyle(e.target.value)}
                                        className="input-field !w-auto text-xs py-1.5"
                                    >
                                        <option value="pill">Píldora</option>
                                        <option value="classic">Clásico</option>
                                        <option value="dark">Oscuro</option>
                                        <option value="yellow">Amarillo</option>
                                        <option value="red">Rojo</option>
                                        <option value="outline">Borde blanco</option>
                                        <option value="outline_yellow">Borde amarillo</option>
                                    </select>
                                )}
                                {autoHook && (
                                    <p className="w-full text-[11px] leading-relaxed text-muted">
                                        Puedes cambiar el texto, estilo, tamaño y posición del gancho en cualquier momento.
                                    </p>
                                )}
                            </div>

                            {/* Section: Cut partial video range */}
                            <div className="col-span-1 sm:col-span-3 pt-3 sm:pt-2 border-t border-rule">
                                <div className="flex items-center justify-between gap-2 mb-2">
                                    <span className="text-xs font-medium text-ink2 flex items-center gap-1.5">
                                        <Scissors size={13} className="text-brass" />
                                        recortar sección del vídeo (vídeos largos / directos)
                                    </span>
                                    {rangePreset !== 'all' && (
                                        <span className="text-[11px] px-2 py-0.5 rounded bg-brass/10 text-brass font-mono">
                                            {rangeStartMin || 0}m — {rangeEndMin ? `${rangeEndMin}m` : 'final'}
                                        </span>
                                    )}
                                </div>

                                <div className="flex flex-wrap gap-1.5 mb-2.5">
                                    {[
                                        { id: 'all', label: 'Todo el vídeo' },
                                        { id: 'first_30', label: 'Primeros 30 min' },
                                        { id: 'first_60', label: '1ª hora (0 - 60m)' },
                                        { id: 'first_90', label: '1h 30m (0 - 90m)' },
                                        { id: 'second_hour', label: '2ª hora (60 - 120m)' },
                                        { id: 'custom', label: 'Personalizado' },
                                    ].map((p) => {
                                        const active = rangePreset === p.id;
                                        return (
                                            <button
                                                key={p.id}
                                                type="button"
                                                onClick={() => applyRangePreset(p.id)}
                                                className={`px-2.5 py-1 text-xs rounded transition-all ${
                                                    active
                                                        ? 'bg-brass text-black font-medium shadow-sm'
                                                        : 'bg-white/5 hover:bg-white/10 text-muted hover:text-ink border border-rule'
                                                }`}
                                            >
                                                {p.label}
                                            </button>
                                        );
                                    })}
                                </div>

                                {rangePreset !== 'all' && (
                                    <div className="grid grid-cols-2 gap-2 mt-2 bg-surface/50 p-2.5 rounded border border-rule animate-fade">
                                        <div>
                                            <p className="eyebrow mb-1 text-[10px]">desde minuto</p>
                                            <input
                                                type="number"
                                                min="0"
                                                step="1"
                                                value={rangeStartMin}
                                                onChange={(e) => handleCustomRangeChange(e.target.value, rangeEndMin)}
                                                placeholder="0"
                                                className="input-field text-xs py-1"
                                            />
                                        </div>
                                        <div>
                                            <p className="eyebrow mb-1 text-[10px]">hasta minuto (vacío = al final)</p>
                                            <input
                                                type="number"
                                                min="1"
                                                step="1"
                                                value={rangeEndMin}
                                                onChange={(e) => handleCustomRangeChange(rangeStartMin, e.target.value)}
                                                placeholder="ej: 90"
                                                className="input-field text-xs py-1"
                                            />
                                        </div>
                                        <p className="col-span-2 text-[11px] text-muted">
                                            ⚡ Solo se descargará y procesará este tramo, ahorrando tiempo y almacenamiento en vídeos largos de 2 a 5 horas.
                                        </p>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                <label className="flex items-start gap-2.5 mt-5 text-left text-[13px] sm:text-xs leading-relaxed text-muted cursor-pointer select-none">
                    <input
                        type="checkbox"
                        checked={acknowledged}
                        onChange={(e) => setAcknowledged(e.target.checked)}
                        className="mt-0.5 w-4 h-4 shrink-0 accent-[var(--color-accent)] cursor-pointer"
                    />
                    <span>
                        Confirmo que tengo los derechos para procesar este video y soy responsable del contenido subido. Ver <a href="/terms" target="_blank" rel="noopener noreferrer" className="text-ink2 underline underline-offset-2 hover:text-brass transition-colors" onClick={(e) => e.stopPropagation()}>Términos</a> y <a href="/privacy" target="_blank" rel="noopener noreferrer" className="text-ink2 underline underline-offset-2 hover:text-brass transition-colors" onClick={(e) => e.stopPropagation()}>Privacidad</a>.
                    </span>
                </label>

                <button
                    type="submit"
                    data-tutorial="generate"
                    disabled={isProcessing || !acknowledged || (mode === 'url' && !url) || (mode === 'file' && (!file || fileTooShort))}
                    className="w-full btn-primary mt-4"
                >
                    {isProcessing || checkingUrl ? (
                        <>
                            <Loader2 size={16} className="animate-spin" />
                            {checkingUrl ? 'Comprobando enlace...' : 'Procesando Video...'}
                        </>
                    ) : (
                        <>
                            Generar Clips Virales
                        </>
                    )}
                </button>
            </form>

            {/* Modal de advertencia cuando el enlace ya fue utilizado */}
            {showUsedModal && usedUrlInfo && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade">
                    <div className="card max-w-md w-full p-6 space-y-4 border border-amber-500/40 shadow-2xl relative text-left">
                        <button
                            type="button"
                            onClick={() => setShowUsedModal(false)}
                            className="absolute top-4 right-4 text-muted hover:text-ink transition-colors"
                        >
                            <X size={18} />
                        </button>

                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 shrink-0">
                                <AlertTriangle size={22} />
                            </div>
                            <div>
                                <h3 className="font-display text-lg text-ink">¡Enlace ya utilizado!</h3>
                                <p className="text-muted text-xs">Este video ya fue procesado anteriormente en tu cuenta.</p>
                            </div>
                        </div>

                        <div className="p-3.5 bg-paper3/60 rounded-lg border border-rule text-xs space-y-2">
                            <p className="text-ink font-medium leading-snug" title={usedUrlInfo.title}>
                                🎬 {usedUrlInfo.title || 'Video procesado'}
                            </p>
                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted text-[11px] pt-1 border-t border-rule/50">
                                {usedUrlInfo.date && (
                                    <span>📅 {usedUrlInfo.date}</span>
                                )}
                                {usedUrlInfo.clips_count > 0 && (
                                    <span className="text-brass font-medium">✂️ {usedUrlInfo.clips_count} clips disponibles</span>
                                )}
                            </div>
                        </div>

                        <p className="text-xs text-muted leading-relaxed">
                            ¿Qué deseas hacer? Puedes ver los clips que ya generaste sin gastar tiempo ni recursos, o volver a procesar el video desde cero.
                        </p>

                        <div className="flex flex-col sm:flex-row gap-2 pt-2">
                            {onViewJob && usedUrlInfo.job_id && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        setShowUsedModal(false);
                                        onViewJob(usedUrlInfo.job_id);
                                    }}
                                    className="btn-primary flex-1 py-2.5 flex items-center justify-center gap-2 text-xs font-medium"
                                >
                                    <Eye size={15} />
                                    Ver clips existentes
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={() => {
                                    setShowUsedModal(false);
                                    const advanced = {
                                        targetClips: targetClips || null,
                                        clipMinSeconds: clipMinSeconds || null,
                                        clipMaxSeconds: clipMaxSeconds || null,
                                        autoHook,
                                        autoHookStyle,
                                        layout,
                                        sourceStart: (range && range.start != null) ? Math.round(range.start) : null,
                                        sourceEnd: (range && range.end != null) ? Math.round(range.end) : null,
                                    };
                                    onProcess({ type: 'url', payload: url, acknowledged: true, outputFormat, ...advanced });
                                }}
                                className="btn-ghost flex-1 py-2.5 flex items-center justify-center gap-2 text-xs border border-rule hover:border-brass transition-colors"
                            >
                                <RefreshCw size={14} />
                                Procesar de nuevo
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
