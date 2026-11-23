import React, { useState, useEffect } from 'react';
import { Calendar, Clock, Sparkles, Loader2, CheckCircle2, AlertCircle, X, ChevronRight } from 'lucide-react';
import { apiFetch } from '../lib/api';

export default function SmartScheduleModal({ isOpen, onClose, clips, jobId }) {
    const [loadingPlan, setLoadingPlan] = useState(false);
    const [scheduling, setScheduling] = useState(false);
    const [plannedClips, setPlannedClips] = useState([]);
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!isOpen || !clips || clips.length === 0) {
            setPlannedClips([]);
            setResult(null);
            setError(null);
            return;
        }

        const fetchPlan = async () => {
            setLoadingPlan(true);
            setError(null);
            try {
                const payload = {
                    clips: clips.map((c, i) => {
                        const title = c.video_title_for_facebook || c.video_title_for_youtube_short || c.viral_hook_text || c.headline || c.title || `Clip #${i + 1}`;
                        const description = c.video_description_for_facebook || c.video_description_for_tiktok || c.video_description_for_instagram || c.post_text || c.caption || c.description || '';
                        return {
                            clip_index: i,
                            video_url: c.video_url || '',
                            video_path: c.video_path || c.video_url || '',
                            title: title,
                            description: description,
                            score: c.score || 0
                        };
                    })
                };
                const res = await apiFetch('/api/social/plan-batch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (res.ok) {
                    const data = await res.json();
                    setPlannedClips(data.planned_clips || []);
                } else {
                    setError('No se pudo calcular la planificación inteligente.');
                }
            } catch (err) {
                setError(err.message || 'Error de conexión.');
            } finally {
                setLoadingPlan(false);
            }
        };

        fetchPlan();
    }, [isOpen, clips]);

    const handleConfirmSchedule = async () => {
        setScheduling(true);
        setError(null);
        try {
            const payload = {
                job_id: jobId || '',
                clips: plannedClips
            };
            const res = await apiFetch('/api/social/schedule-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (res.ok) {
                const data = await res.json();
                setResult(data);
            } else {
                const errData = await res.json().catch(() => ({}));
                setError(errData.detail || 'Error al programar en lote.');
            }
        } catch (err) {
            setError(err.message || 'Error al enviar a la cola.');
        } finally {
            setScheduling(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade">
            <div className="relative w-full max-w-2xl bg-paper2 border border-rule rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
                {/* Header */}
                <div className="p-5 border-b border-rule flex items-center justify-between bg-paper3/50">
                    <div className="flex items-center gap-2.5">
                        <div className="p-2 rounded-xl bg-brass/10 border border-brass/30 text-brass">
                            <Calendar size={20} />
                        </div>
                        <div>
                            <h2 className="text-base font-semibold text-ink flex items-center gap-2">
                                Programación Inteligente de Clips
                                <span className="inline-flex items-center gap-1 text-[11px] font-normal px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                    <Sparkles size={11} /> Auto Meta
                                </span>
                            </h2>
                            <p className="text-xs text-muted">
                                Distribuye automáticamente tus clips en los mejores horarios de gaming sin canibalizar vistas.
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded-lg text-muted hover:text-ink hover:bg-paper3 transition-colors"
                    >
                        <X size={18} />
                    </button>
                </div>

                {/* Body */}
                <div className="p-5 overflow-y-auto custom-scrollbar space-y-4 flex-1">
                    {loadingPlan ? (
                        <div className="py-12 flex flex-col items-center justify-center gap-3 text-muted">
                            <Loader2 size={32} className="animate-spin text-brass" />
                            <p className="text-sm">Analizando slots óptimos para Latinoamérica y España...</p>
                        </div>
                    ) : result ? (
                        <div className="py-8 text-center space-y-4">
                            <div className="w-14 h-14 mx-auto rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                                <CheckCircle2 size={30} />
                            </div>
                            <div className="space-y-1">
                                <h3 className="text-base font-semibold text-ink">¡Clips en cola de programación!</h3>
                                <p className="text-xs text-muted max-w-md mx-auto">
                                    {result.message || 'Tus clips se están agendando en Meta Business Suite en segundo plano.'}
                                </p>
                            </div>
                            <div className="p-3 bg-paper3/60 rounded-xl border border-rule text-xs text-ink2 max-w-md mx-auto text-left space-y-1">
                                <p className="font-medium text-ink flex items-center gap-1.5">
                                    <Clock size={13} className="text-brass" /> Puedes apagar tu PC una vez programados
                                </p>
                                <p className="text-muted leading-relaxed">
                                    Meta guarda los videos en sus servidores y los publicará automáticamente en tu página a las horas asignadas.
                                </p>
                            </div>
                            <button
                                onClick={onClose}
                                className="mt-4 px-6 py-2 rounded-xl bg-brass text-black font-medium text-sm hover:brightness-110 transition-all shadow-md"
                            >
                                Entendido, cerrar
                            </button>
                        </div>
                    ) : (
                        <>
                            <div className="p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 text-xs text-blue-200 flex items-start gap-2.5">
                                <Sparkles size={16} className="text-blue-400 shrink-0 mt-0.5" />
                                <div>
                                    <p className="font-medium text-white mb-0.5">Cobertura continental 24/7</p>
                                    <p className="text-blue-200/80 leading-relaxed">
                                        Cada turno caza las horas pico de Colombia, México, Argentina y España, con 2.5 a 4 horas de separación limpia entre videos.
                                    </p>
                                </div>
                            </div>

                            {error && (
                                <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-300 flex items-center gap-2">
                                    <AlertCircle size={16} className="text-red-400 shrink-0" />
                                    <span>{error}</span>
                                </div>
                            )}

                            {/* Clips List */}
                            <div className="space-y-2">
                                <p className="text-xs font-medium text-muted uppercase tracking-wider px-1">
                                    Plan de publicación ({plannedClips.length} clips)
                                </p>
                                <div className="space-y-2">
                                    {plannedClips.map((item, idx) => (
                                        <div
                                            key={idx}
                                            className="p-3 rounded-xl bg-paper3 border border-rule flex items-center justify-between gap-3 hover:border-rule/80 transition-all"
                                        >
                                            <div className="flex items-center gap-3 min-w-0">
                                                <div className="w-7 h-7 rounded-lg bg-paper2 border border-rule flex items-center justify-center text-xs font-semibold text-brass shrink-0">
                                                    #{idx + 1}
                                                </div>
                                                <div className="min-w-0">
                                                    <p className="text-xs font-medium text-ink truncate">
                                                        {item.title}
                                                    </p>
                                                    <p className="text-[11px] text-muted flex items-center gap-1.5 mt-0.5">
                                                        <span>Calidad: {item.score}/100</span>
                                                    </p>
                                                </div>
                                            </div>

                                            <div className="shrink-0 text-right">
                                                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-brass/10 border border-brass/30 text-brass text-xs font-medium">
                                                    <Clock size={12} />
                                                    {item.display_slot}
                                                </span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </>
                    )}
                </div>

                {/* Footer */}
                {!result && !loadingPlan && (
                    <div className="p-4 border-t border-rule bg-paper3/40 flex items-center justify-between gap-3">
                        <button
                            onClick={onClose}
                            className="px-4 py-2 text-xs font-medium text-muted hover:text-ink transition-colors"
                        >
                            Cancelar
                        </button>

                        <button
                            onClick={handleConfirmSchedule}
                            disabled={scheduling || plannedClips.length === 0}
                            className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white font-medium text-xs flex items-center gap-2 shadow-lg disabled:opacity-50 transition-all cursor-pointer"
                        >
                            {scheduling ? (
                                <>
                                    <Loader2 size={14} className="animate-spin" />
                                    Agendando en Meta...
                                </>
                            ) : (
                                <>
                                    <Calendar size={14} />
                                    Programar todos ({plannedClips.length}) en Meta
                                </>
                            )}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
