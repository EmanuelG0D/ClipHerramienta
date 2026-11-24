import React, { useState, useEffect, useRef } from 'react';
import { Download, Share2, AlertCircle, Loader2, Copy, Check, Wand2, Type, Calendar, Languages, FileText, Link2, Scissors, Crosshair, TrendingUp, Sparkles } from 'lucide-react';
import { getApiUrl } from '../config';
import { apiFetch } from '../lib/api';
import { platformOptions as buildPlatformOptions, defaultPlatformFlags, flagsFromList } from '../lib/socialPlatforms';
import { track } from '../lib/analytics';
import SubtitleModal from './SubtitleModal';
import HookModal from './HookModal';
import TranslateModal from './TranslateModal';
import Modal from './ui/Modal';
import SegmentedControl from './ui/SegmentedControl';
import WatermarkModal, { watermarkNoticeDismissed } from './WatermarkModal';
import TikTokDraftNotice from './TikTokDraftNotice';
import { useAuth } from '../contexts/AuthContext';
import { renderInBrowser } from '../lib/renderInBrowser';

const QUIET_BTN = 'group flex flex-col items-center justify-center gap-1 py-2.5 sm:py-2 px-1 rounded-input border border-rule hover:bg-paper3 text-[11px] lowercase text-ink2 whitespace-nowrap transition-colors disabled:opacity-45 disabled:cursor-not-allowed';

// Follow an async post (request_id from /api/social/post) for about a minute.
// Returns {done, failed}: done once every platform finished, failed lists
// "platform: reason" for the ones that did not. Unknown or slow = neither.
const POST_TERMINAL = new Set(['completed', 'failed', 'not_found']);
async function followPost(requestId, tries = 12, everyMs = 5000) {
    for (let i = 0; i < tries; i++) {
        await new Promise((r) => setTimeout(r, everyMs));
        let d;
        try {
            const r = await apiFetch(`/api/social/post-status/${encodeURIComponent(requestId)}`);
            if (!r.ok) continue;
            d = await r.json();
        } catch {
            continue;
        }
        if (d.status === 'unknown') return { done: false, failed: [] };
        if (!POST_TERMINAL.has(d.status)) continue;
        const failed = (d.results || [])
            .filter((x) => x.success === false)
            .map((x) => `${x.platform}${x.message ? `: ${x.message}` : ''}`);
        if (d.status !== 'completed' && !failed.length) failed.push('every platform');
        return { done: d.status === 'completed', failed };
    }
    return { done: false, failed: [] };
}

const PLATFORM_OPTIONS = buildPlatformOptions({ lower: true });

function clipDurationSeconds(clip) {
    // A recut clip's start/end are the covering source range (segments may be
    // non-contiguous or reordered); its real duration is the segment sum.
    const segments = clip.recipe?.segments;
    if (segments?.length) {
        return segments.reduce((acc, s) => acc + (s.end - s.start), 0);
    }
    return clip.end && clip.start ? clip.end - clip.start : NaN;
}

function formatDuration(clip) {
    const secs = Math.floor(clipDurationSeconds(clip));
    if (!Number.isFinite(secs) || secs < 0) return null;
    return `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
}

export default function ResultCard({ clip, index, jobId, durable, uploadPostKey, uploadUserId, geminiApiKey, elevenLabsKey, isManaged, onPlay, onPause, onBulkSubtitle, clipCount = 1, bulkProgress, initialState = null, onStateChange, connectedPlatforms = null, onConnectSocials, onEditClip = null, onReframeClip = null, onModeChanged = null, onUpgrade = null }) {
    const [showModal, setShowModal] = useState(false);
    // The "why" line is clamped to two lines so cards in a row stay level;
    // when it overflows, a hover (desktop) or tap (touch) shows the whole
    // sentence in a popover that floats over the card instead of growing it.
    const whyRef = useRef(null);
    const [whyOpen, setWhyOpen] = useState(false);
    const [whyClamped, setWhyClamped] = useState(false);
    useEffect(() => {
        const el = whyRef.current;
        if (!el) return;
        const check = () => setWhyClamped(el.scrollHeight > el.clientHeight + 1);
        check();
        window.addEventListener('resize', check);
        return () => window.removeEventListener('resize', check);
    }, [clip.why]);
    const [showDescModal, setShowDescModal] = useState(false);
    const [showSubtitleModal, setShowSubtitleModal] = useState(false);
    const [showWatermarkModal, setShowWatermarkModal] = useState(false);
    const [socialTab, setSocialTab] = useState('facebook');
    const { plan } = useAuth();
    const videoRef = React.useRef(null);
    // Pristine base clip (no burned subtitles/hook), stable regardless of how
    // clip.video_url mutates after server edits. Used as the compositing base
    // for the Remotion preview so it never stacks subtitles over an already-
    // subtitled file (double-subtitle bug).
    const stripBurns = (filename) => {
        let f = filename || '', prev;
        do { prev = f; f = f.replace(/^subtitled_\d+_/, '').replace(/^hooked_\d+_/, '').replace(/^hook_/, ''); } while (f !== prev);
        return f;
    };
    const originalVideoUrl = getApiUrl((clip.video_url || '').replace(/[^/]+$/, stripBurns((clip.video_url || '').split('/').pop())));
    const [currentVideoUrl, setCurrentVideoUrl] = useState(getApiUrl(clip.video_url));
    // Where the <video> element pulls its bytes from. The clips are archived to
    // R2 anyway, and R2 egress is free and edge-served, while /videos is served
    // by the same single-worker API process that is running the renders. So play
    // from R2 when possible.
    //
    // ONLY when R2 holds exactly the file the server considers current for this
    // clip (durable.filename === serverVideoFile). Every server-side edit sends
    // input_filename: serverVideoFile and rewrites clip.video_url, but the R2
    // re-archive behind it is fire-and-forget, so for a few seconds the durable
    // copy is the PRE-edit clip. Preferring it blindly would silently show the
    // clip without the subtitles/hook the user just burned.
    //
    // This is display-only: currentVideoUrl remains the source of truth for the
    // download button and for every server operation, so no edit can be routed
    // to the wrong file by this.
    const [durableSrc, setDurableSrc] = useState(null);
    const [durableFailed, setDurableFailed] = useState(false);
    // Switching src reloads the element and restarts playback, so the durable copy
    // is only ever adopted before the user has touched this player. After an edit
    // the chase in App.jsx can land while they are watching the result, and losing
    // their position to save a few seconds of buffering is a bad trade.
    const [hasPlayed, setHasPlayed] = useState(false);

    // A delivered clip is tens of MB, and on a slow link the old silent
    // fetch-then-save took minutes with nothing on screen, which reads as a dead
    // button. Stream it instead and report progress.
    const [downloadPct, setDownloadPct] = useState(null);

    const downloadClip = async () => {
        try {
            setDownloadPct(0);
            const response = await fetch(currentVideoUrl);
            if (!response.ok) throw new Error('Download failed');
            const total = Number(response.headers.get('content-length')) || 0;
            let blob;
            // No body reader (old browser) or no length to measure against: fall
            // back to the plain path rather than lose the download.
            if (!response.body || !total) {
                blob = await response.blob();
            } else {
                const reader = response.body.getReader();
                const chunks = [];
                let received = 0;
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                    received += value.length;
                    setDownloadPct(Math.min(99, Math.round((received / total) * 100)));
                }
                blob = new Blob(chunks, { type: 'video/mp4' });
            }
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = `clip-${index + 1}.mp4`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
        } catch (err) {
            console.error('Download error:', err);
            window.open(currentVideoUrl, '_blank');
        } finally {
            setDownloadPct(null);
        }
    };
    // Latest file that exists ON THE SERVER (blob: previews don't count).
    // All server-side operations must chain from this, so burned-in edits
    // (subtitles, hooks, effects) never get silently dropped.
    // A reopened project seeds it from the persisted project state.
    const [serverVideoFile, setServerVideoFile] = useState(initialState?.server_file || (clip.video_url || '').split('/').pop());
    const [videoErrored, setVideoErrored] = useState(false);
    const [resolution, setResolution] = useState(null);

    // Adopt the durable copy only while it matches the current server file, and
    // pin the first signed URL seen for that file: /api/history mints a fresh
    // signature on every call, and swapping src mid-playback restarts the video.
    useEffect(() => {
        if (durable?.url && durable.filename && durable.filename === serverVideoFile && !hasPlayed) {
            setDurableSrc((prev) => prev || durable.url);
        } else {
            setDurableSrc(null);
        }
    }, [durable?.url, durable?.filename, serverVideoFile, hasPlayed]);

    // If the local video failed and a durable R2 URL is (now) available, use it.
    // Handles the race where the video errors before the durable URL has loaded.
    // Deliberately NOT version-gated: reaching here means the local file is gone
    // (retention sweep after a reload), so an older durable copy still beats a
    // broken player.
    useEffect(() => {
        if (videoErrored && durable?.url && currentVideoUrl !== durable.url) {
            setCurrentVideoUrl(durable.url);
            setVideoErrored(false);
        }
    }, [videoErrored, durable, currentVideoUrl]);

    // When an external refresh changes this clip's server file (e.g. bulk
    // subtitles applied from another card), adopt it so the card shows the
    // freshly subtitled video instead of a stale one.
    useEffect(() => {
        const serverUrl = getApiUrl(clip.video_url);
        const serverName = (clip.video_url || '').split('/').pop();
        if (serverName && serverName !== serverVideoFile) {
            setServerVideoFile(serverName);
            setCurrentVideoUrl(serverUrl);
            setDurableFailed(false);
            setHasPlayed(false);
            if (videoRef.current) videoRef.current.load();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clip.video_url]);

    const [platforms, setPlatforms] = useState(defaultPlatformFlags);
    const [postTitle, setPostTitle] = useState("");
    const [postDescription, setPostDescription] = useState("");
    const [isScheduling, setIsScheduling] = useState(false);
    const [scheduleDate, setScheduleDate] = useState("");

    const [posting, setPosting] = useState(false);
    const [postResult, setPostResult] = useState(null);
    const [copied, setCopied] = useState(null);
    const [browserPosting, setBrowserPosting] = useState(null);
    const [browserMsg, setBrowserMsg] = useState(null);

    const handleBrowserOpen = async (platform) => {
        const title = platform === 'facebook' ? (clip.video_title_for_facebook || postTitle) : (platform === 'instagram' ? (clip.video_title_for_instagram || postTitle) : (clip.video_title_for_tiktok || postTitle));
        const desc = platform === 'facebook' ? (clip.video_description_for_facebook || postDescription) : (platform === 'instagram' ? (clip.video_description_for_instagram || postDescription) : (clip.video_description_for_tiktok || postDescription));
        const fullText = title ? `${title}\n\n${desc}` : desc;

        // Copiar texto y hashtags al portapapeles de Windows por respaldo
        try {
            await navigator.clipboard.writeText(fullText);
        } catch (_) {}

        setBrowserPosting(platform);
        setBrowserMsg('⏳ Subiendo video, procesando reel y publicando en Facebook... Espera unos 20-30 segundos.');
        try {
            const res = await apiFetch('/api/social/browser-open', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    platform,
                    video_url: clip.video_url,
                    title,
                    description: desc
                })
            });
            const data = await res.json();
            if (data.published) {
                setBrowserMsg(`🎉 ¡REEL PUBLICADO CON ÉXITO! Ya está disponible en tu página de Facebook "Tu Viejo Confiable".`);
            } else if (data.success) {
                setBrowserMsg(`🚀 ${data.message || 'Video y texto procesados con éxito.'}`);
            } else {
                setBrowserMsg(`⚠️ Aviso: ${data.error || data.detail || 'No se pudo completar la publicación automática.'}`);
            }
        } catch (err) {
            setBrowserMsg(`⚠️ Error: ${err.message}`);
        } finally {
            setBrowserPosting(null);
        }
    };

    const handleCopy = async (field, text) => {
        try {
            await navigator.clipboard.writeText(text || '');
            setCopied(field);
            setTimeout(() => setCopied(null), 2000);
        } catch {
            // clipboard unavailable — silent
        }
    };

    const [isEditing, setIsEditing] = useState(false);
    const [isSubtitling, setIsSubtitling] = useState(false);
    const [isHooking, setIsHooking] = useState(false);
    const [isTranslating, setIsTranslating] = useState(false);
    const [showHookModal, setShowHookModal] = useState(false);
    const [showTranslateModal, setShowTranslateModal] = useState(false);
    const [editError, setEditError] = useState(null);

    // Pro mode: the talking-head re-edit (tighter frame on the face, dead air
    // cut, graded picture). The server renders a new file both ways, so the
    // card remounts from it exactly like after a recut.
    const isPro = clip.mode === 'pro';
    const [isSwitchingMode, setIsSwitchingMode] = useState(false);
    // Pro mode frames a face in a vertical clip: on a horizontal or square
    // one the server refuses, so the switch is not offered there. Unknown
    // until the video's metadata loads, and offered meanwhile.
    const [isUpright, setIsUpright] = useState(true);
    const canSwitchMode = Boolean(onModeChanged) && (isUpright || isPro);
    const handleMode = async () => {
        setIsSwitchingMode(true);
        setEditError(null);
        try {
            const res = await apiFetch('/api/clip/mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    job_id: jobId,
                    clip_index: index,
                    mode: isPro ? 'normal' : 'pro',
                    input_filename: serverVideoFile,
                }),
            });
            if (!res.ok) {
                let detail = '';
                try { detail = (await res.json()).detail; } catch { /* not JSON */ }
                throw new Error(typeof detail === 'string' && detail ? detail : 'Could not switch the clip mode.');
            }
            const data = await res.json();
            track('ClipModeSwitched', { props: { mode: data.mode } });
            if (onModeChanged && data.new_video_url) onModeChanged(index, data);
        } catch (e) {
            setEditError(e.message);
            setTimeout(() => setEditError(null), 6000);
        } finally {
            setIsSwitchingMode(false);
        }
    };

    const [clipDuration, setClipDuration] = useState(() => {
        const secs = clipDurationSeconds(clip);
        return Number.isFinite(secs) ? secs : 30;
    });

    // Accumulate Remotion layers across operations. A reopened project restores
    // the layers persisted in its project state, so the next edit composes over
    // them instead of silently dropping previous browser-side work.
    const [activeLayers, setActiveLayers] = useState(initialState?.active_layers || { subtitles: null, hook: null, effects: null });

    // Report edit state upward (debounced sync to the project record). Skip the
    // mount run: only user-driven changes are worth persisting.
    const stateReported = React.useRef(false);
    useEffect(() => {
        if (!stateReported.current) { stateReported.current = true; return; }
        onStateChange?.(index, { activeLayers, serverVideoFile });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeLayers, serverVideoFile]);

    // True when the current server file already carries burned-in content.
    // Browser (Remotion) renders compose over the ORIGINAL clip, so using them
    // here would silently drop those burns — chain via server FFmpeg instead.
    const hasServerBurns = /(^|_)(subtitled|hook|hooked)_/.test(serverVideoFile || '');

    // The hook currently burned into the server file (auto-hook or a manual
    // one). /api/hook REPLACES it; tracked locally so the modal stays honest
    // after edits without refetching the job.
    const [burnedHook, setBurnedHook] = useState(clip.auto_hook?.text || null);

    // Fetch clip duration from transcript endpoint
    useEffect(() => {
        if (!jobId || index === undefined) return;
        apiFetch(`/api/clip/${jobId}/${index}/transcript`)
            .then(res => res.ok ? res.json() : null)
            .then(data => {
                if (data && data.durationSec) setClipDuration(data.durationSec);
            })
            .catch(() => {});
    }, [jobId, index]);

    // Which platforms the selected profile actually has linked. `null` means
    // unknown (profile list not loaded) — in that case nothing is gated.
    const knownConnections = Array.isArray(connectedPlatforms);
    const noAccountsConnected = knownConnections && connectedPlatforms.length === 0;
    const platformOptions = knownConnections
        ? PLATFORM_OPTIONS.map((o) => (connectedPlatforms.includes(o.value) ? o : { ...o, disabled: true, hint: 'not connected' }))
        : PLATFORM_OPTIONS;

    const handleConnectAccounts = () => {
        setShowModal(false);
        if (onConnectSocials) onConnectSocials();
        else window.open('https://app.upload-post.com', '_blank', 'noopener');
    };

    // Initialize/Reset form when modal opens
    useEffect(() => {
        if (showModal) {
            setPostTitle(clip.video_title_for_youtube_short || "Viral Short");
            setPostDescription(clip.video_description_for_instagram || clip.video_description_for_tiktok || "");
            setIsScheduling(false);
            setScheduleDate("");
            setPostResult(null);
            // Only preselect platforms the profile can actually publish to.
            if (knownConnections) {
                setPlatforms(flagsFromList(connectedPlatforms));
            }
        }
        // Reset only when the modal opens for a clip; connection changes while
        // it is open must not wipe the user's selection.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showModal, clip]);

    const handleAutoEdit = async () => {
        setIsEditing(true);
        setEditError(null);
        try {
            const apiKey = geminiApiKey || localStorage.getItem('gemini_key');

            // Managed (paid) users get the Gemini key resolved server-side;
            // only BYOK/self-host needs a local key.
            if (!apiKey && !isManaged) {
                throw new Error("Gemini API Key is missing. Please set it in Settings.");
            }
            const geminiHeaders = apiKey ? { 'X-Gemini-Key': apiKey } : {};

            // Try Remotion effects endpoint first
            const effectsRes = hasServerBurns ? null : await apiFetch('/api/effects/generate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...geminiHeaders
                },
                body: JSON.stringify({
                    job_id: jobId,
                    clip_index: index,
                    input_filename: serverVideoFile
                })
            });

            if (effectsRes && effectsRes.ok) {
                const data = await effectsRes.json();
                if (data.effects && data.effects.segments) {
                    const newLayers = { ...activeLayers, effects: data.effects };
                    setActiveLayers(newLayers);
                    const blobUrl = await renderInBrowser({
                        videoUrl: originalVideoUrl,
                        durationInSeconds: clipDuration,
                        subtitles: newLayers.subtitles,
                        hook: newLayers.hook,
                        effects: newLayers.effects,
                    });
                    setCurrentVideoUrl(blobUrl);
                    if (videoRef.current) videoRef.current.load();
                    return;
                }
            }

            // Fallback: legacy FFmpeg edit endpoint
            const res = await apiFetch('/api/edit', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...geminiHeaders
                },
                body: JSON.stringify({
                    job_id: jobId,
                    clip_index: index,
                    input_filename: serverVideoFile
                })
            });

            if (!res.ok) {
                const errText = await res.text();
                try {
                    const jsonErr = JSON.parse(errText);
                    throw new Error(jsonErr.detail || errText);
                } catch (e) {
                    throw new Error(errText);
                }
            }

            const data = await res.json();
            if (data.new_video_url) {
                setCurrentVideoUrl(getApiUrl(data.new_video_url));
                setServerVideoFile(data.new_video_url.split('/').pop());
                if (videoRef.current) {
                    videoRef.current.load();
                }
            }

        } catch (e) {
            setEditError(e.message);
            setTimeout(() => setEditError(null), 5000);
        } finally {
            setIsEditing(false);
        }
    };

    // Clips are captioned by default, so "no captions" has to be reachable.
    // Nothing is re-encoded: the server still holds the clean file next to the
    // captioned one and just points this clip back at it.
    const handleRemoveSubtitles = async () => {
        setIsSubtitling(true);
        setEditError(null);
        try {
            const res = await apiFetch('/api/subtitle/remove', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    job_id: jobId, clip_index: index, input_filename: serverVideoFile,
                }),
            });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            if (data.new_video_url) {
                const serverUrl = getApiUrl(data.new_video_url);
                setServerVideoFile(data.new_video_url.split('/').pop());
                const remaining = { ...activeLayers, subtitles: null };
                setActiveLayers(remaining);
                if (remaining.hook || remaining.effects) {
                    setCurrentVideoUrl(await renderInBrowser({
                        videoUrl: serverUrl,
                        durationInSeconds: clipDuration,
                        subtitles: null,
                        hook: remaining.hook,
                        effects: remaining.effects,
                    }));
                } else {
                    setCurrentVideoUrl(serverUrl);
                }
                if (videoRef.current) videoRef.current.load();
                setShowSubtitleModal(false);
            }
        } catch (e) {
            setEditError(e.message);
            setTimeout(() => setEditError(null), 5000);
        } finally {
            setIsSubtitling(false);
        }
    };

    const handleSubtitle = async (options) => {
        setIsSubtitling(true);
        setEditError(null);
        try {
            // Karaoke styles are burned server-side (ASS word-highlight render);
            // the in-browser Remotion path only handles classic styles, and only
            // when the server file has no burned-in content to preserve.
            if (options.remotion && options.style !== 'karaoke' && !hasServerBurns) {
                // Accumulate layer and render all layers together
                const newLayers = { ...activeLayers, subtitles: options.remotion };
                setActiveLayers(newLayers);
                const blobUrl = await renderInBrowser({
                    videoUrl: originalVideoUrl,
                    durationInSeconds: clipDuration,
                    subtitles: newLayers.subtitles,
                    hook: newLayers.hook,
                    effects: newLayers.effects,
                });
                setCurrentVideoUrl(blobUrl);
                if (videoRef.current) videoRef.current.load();
                setShowSubtitleModal(false);
                return;
            }

            // Fallback: legacy FFmpeg
            const res = await apiFetch('/api/subtitle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    job_id: jobId,
                    clip_index: index,
                    position: options.position,
                    font_size: options.fontSize,
                    font_name: options.fontName,
                    font_color: options.fontColor,
                    border_color: options.borderColor,
                    border_width: options.borderWidth,
                    bg_color: options.bgColor,
                    bg_opacity: options.bgOpacity,
                    style: options.style || 'classic',
                    highlight_color: options.highlightColor || '#FFD700',
                    effect: options.effect || 'none',
                    base_opacity: options.baseOpacity ?? 1.0,
                    uppercase: options.uppercase || false,
                    reveal: options.reveal || false,
                    shadow: options.shadow || 0,
                    max_chars: options.maxChars ?? null,
                    max_duration: options.maxDuration ?? null,
                    input_filename: serverVideoFile,
                    // Edited caption text (clip-relative ms); null = server
                    // regenerates from the transcript as before.
                    words: options.captions || null
                })
            });

            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            if (data.new_video_url) {
                const serverUrl = getApiUrl(data.new_video_url);
                setServerVideoFile(data.new_video_url.split('/').pop());
                // Subtitles are burned into the server file now — drop the
                // browser subtitle layer and re-compose any remaining browser
                // layers (hook/effects) over the new file so they aren't lost.
                const remaining = { ...activeLayers, subtitles: null };
                setActiveLayers(remaining);
                if (remaining.hook || remaining.effects) {
                    const blobUrl = await renderInBrowser({
                        videoUrl: serverUrl,
                        durationInSeconds: clipDuration,
                        subtitles: null,
                        hook: remaining.hook,
                        effects: remaining.effects,
                    });
                    setCurrentVideoUrl(blobUrl);
                } else {
                    setCurrentVideoUrl(serverUrl);
                }
                if (videoRef.current) videoRef.current.load();
                setShowSubtitleModal(false);
            }
        } catch (e) {
            setEditError(e.message);
            setTimeout(() => setEditError(null), 5000);
        } finally {
            setIsSubtitling(false);
        }
    };

    const handleHook = async (hookData) => {
        setIsHooking(true);
        setEditError(null);
        try {
            if (hookData.remotion && !hasServerBurns) {
                // Accumulate layer and render all layers together
                const newLayers = { ...activeLayers, hook: hookData.remotion };
                setActiveLayers(newLayers);
                const blobUrl = await renderInBrowser({
                    videoUrl: originalVideoUrl,
                    durationInSeconds: clipDuration,
                    subtitles: newLayers.subtitles,
                    hook: newLayers.hook,
                    effects: newLayers.effects,
                });
                setCurrentVideoUrl(blobUrl);
                if (videoRef.current) videoRef.current.load();
                setShowHookModal(false);
                return;
            }

            // Fallback: legacy FFmpeg
            const payload = typeof hookData === 'string'
                ? { text: hookData, position: 'top', size: 'M' }
                : hookData;

            const res = await apiFetch('/api/hook', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    job_id: jobId,
                    clip_index: index,
                    text: payload.text,
                    position: payload.position,
                    size: payload.size,
                    style: payload.style || 'pill',
                    font: payload.font || null,
                    duration_seconds: payload.remotion?.displayDurationSec ?? null,
                    input_filename: serverVideoFile
                })
            });

            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            if (data.new_video_url) {
                setCurrentVideoUrl(getApiUrl(data.new_video_url));
                setServerVideoFile(data.new_video_url.split('/').pop());
                setBurnedHook(data.burned_hook?.text ?? payload.text ?? null);
                if (videoRef.current) videoRef.current.load();
                setShowHookModal(false);
            }
        } catch (e) {
            setEditError(e.message);
            setTimeout(() => setEditError(null), 5000);
        } finally {
            setIsHooking(false);
        }
    };

    // Strip the burned hook (auto-hook or manual) off the server file.
    const handleRemoveHook = async () => {
        setIsHooking(true);
        setEditError(null);
        try {
            const res = await apiFetch('/api/hook', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    job_id: jobId,
                    clip_index: index,
                    remove: true,
                    input_filename: serverVideoFile,
                }),
            });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            if (data.new_video_url) {
                setCurrentVideoUrl(getApiUrl(data.new_video_url));
                setServerVideoFile(data.new_video_url.split('/').pop());
                setBurnedHook(null);
                if (videoRef.current) videoRef.current.load();
                setShowHookModal(false);
            }
        } catch (e) {
            setEditError(e.message);
            setTimeout(() => setEditError(null), 5000);
        } finally {
            setIsHooking(false);
        }
    };

    const handleTranslate = async (options) => {
        console.log('[Translate] Starting translation with options:', options);
        setIsTranslating(true);
        setEditError(null);
        try {
            const apiKey = elevenLabsKey;
            console.log('[Translate] API Key available:', !!apiKey);

            if (!apiKey) {
                throw new Error("ElevenLabs API Key is missing. Please set it in Settings.");
            }

            const requestBody = {
                job_id: jobId,
                clip_index: index,
                target_language: options.targetLanguage,
                input_filename: serverVideoFile
            };
            console.log('[Translate] Request body:', requestBody);
            console.log('[Translate] Sending request to /api/translate');

            const res = await apiFetch('/api/translate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-ElevenLabs-Key': apiKey
                },
                body: JSON.stringify(requestBody)
            });

            console.log('[Translate] Response status:', res.status);

            if (!res.ok) {
                const errText = await res.text();
                console.error('[Translate] Error response:', errText);
                try {
                    const jsonErr = JSON.parse(errText);
                    throw new Error(jsonErr.detail || errText);
                } catch (e) {
                    if (e.message !== errText) throw e;
                    throw new Error(errText);
                }
            }

            const data = await res.json();
            console.log('[Translate] Success response:', data);
            if (data.new_video_url) {
                setCurrentVideoUrl(getApiUrl(data.new_video_url));
                setServerVideoFile(data.new_video_url.split('/').pop());
                if (videoRef.current) {
                    videoRef.current.load();
                }
                setShowTranslateModal(false);
            }

        } catch (e) {
            console.error('[Translate] Exception:', e);
            setEditError(e.message);
            setTimeout(() => setEditError(null), 5000);
        } finally {
            setIsTranslating(false);
        }
    };

    // Managed (cloud plan/trial) users post with the server-side key — no BYOK needed
    const canPost = isManaged || (uploadPostKey && uploadUserId);

    const handlePost = async () => {
        if (!canPost) {
            setPostResult({ success: false, msg: "Missing API Key or User ID." });
            return;
        }

        if (noAccountsConnected) {
            setPostResult({ success: false, msg: "Connect a social account first." });
            return;
        }

        const selectedPlatforms = Object.keys(platforms).filter(k => platforms[k]);
        if (selectedPlatforms.length === 0) {
            setPostResult({ success: false, msg: "Select at least one platform." });
            return;
        }

        if (isScheduling && !scheduleDate) {
            setPostResult({ success: false, msg: "Please select a date and time." });
            return;
        }

        setPosting(true);
        setPostResult(null);

        try {
            const payload = {
                job_id: jobId,
                clip_index: index,
                api_key: uploadPostKey,
                user_id: uploadUserId,
                platforms: selectedPlatforms,
                title: postTitle,
                description: postDescription
            };

            if (isScheduling && scheduleDate) {
                // Convert to ISO-8601
                payload.scheduled_date = new Date(scheduleDate).toISOString();
                // Optional: pass timezone if needed, backend defaults to UTC or we can send user's timezone
                payload.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            }

            const res = await apiFetch('/api/social/post', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                const errText = await res.text();
                let detail = errText;
                try { detail = JSON.parse(errText).detail || errText; } catch { /* not JSON */ }
                throw new Error(detail);
            }

            const sent = await res.json().catch(() => ({}));
            if (isScheduling || !sent?.request_id) {
                setPostResult({ success: true, msg: isScheduling ? "Scheduled successfully!" : "Sent for publishing." });
                setTimeout(() => {
                    setShowModal(false);
                    setPostResult(null);
                }, 3000);
                return;
            }
            // A 200 only means Upload-Post took the file: follow the post to
            // its real end, so a platform that fails says so here.
            setPostResult({ success: true, msg: "Publishing…" });
            const outcome = await followPost(sent.request_id);
            if (outcome.failed.length) {
                setPostResult({ success: false, msg: `Failed on ${outcome.failed.join('; ')}` });
                track('SocialPostFailed', { props: { platforms: selectedPlatforms.join(',') } });
            } else {
                setPostResult({ success: true, msg: outcome.done ? "Posted successfully!" : "Still publishing: check your accounts in a few minutes." });
                setTimeout(() => {
                    setShowModal(false);
                    setPostResult(null);
                }, 3000);
            }

        } catch (e) {
            setPostResult({ success: false, msg: `Failed: ${e.message}` });
        } finally {
            setPosting(false);
        }
    };

    // Browser-rendered previews (Remotion) live in a blob: URL that exists only
    // in this tab, so they always win over the durable copy.
    const playbackUrl = (durableSrc && !durableFailed && !String(currentVideoUrl || '').startsWith('blob:'))
        ? durableSrc
        : currentVideoUrl;

    const durationReadout = formatDuration(clip);

    return (
        <div className="card overflow-hidden flex flex-col md:flex-row group hover:border-rule2 transition-colors animate-fade md:min-h-[420px]" style={{ animationDelay: `${index * 0.1}s` }}>
            {/* Left: Video Preview — 9:16 column matching the fixed card height */}
            {/* A full-width 9:16 preview on a phone is ~640px tall on its own,
                which pushed the title, captions and every action off-screen.
                Capping the height and centring keeps the whole card scannable
                without letterboxing the clip. */}
            <div className="w-full max-w-[calc(64vh*0.5625)] md:max-w-none mx-auto md:mx-0 md:w-[236px] bg-black relative shrink-0 aspect-[9/16] md:aspect-auto group/video">
                <video
                    ref={videoRef}
                    src={playbackUrl}
                    controls
                    className="w-full h-full object-contain"
                    playsInline
                    onLoadedMetadata={(e) => {
                        if (e.target.videoWidth) {
                            setResolution(`${e.target.videoWidth}×${e.target.videoHeight}`);
                            setIsUpright(e.target.videoHeight > e.target.videoWidth);
                        }
                    }}
                    onError={() => {
                        // The durable copy is unreachable (signature expired after an
                        // hour on an idle tab, object purged) → serve from the API for
                        // the rest of this card's life.
                        if (playbackUrl === durableSrc) {
                            setDurableFailed(true);
                            return;
                        }
                        // Local /videos/ file gone (e.g. cleaned up after a reload) →
                        // fall back to the durable R2 copy for managed users. If the
                        // durable URL hasn't loaded yet, the effect above retries.
                        if (durable?.url && currentVideoUrl !== durable.url) setCurrentVideoUrl(durable.url);
                        else setVideoErrored(true);
                    }}
                    onPlay={() => {
                        setHasPlayed(true);
                        const currentTime = videoRef.current ? videoRef.current.currentTime : 0;
                        onPlay && onPlay(clip.start + currentTime);
                    }}
                    onPause={() => onPause && onPause()}
                    onEnded={() => {
                        if (videoRef.current) {
                            videoRef.current.currentTime = 0;
                            videoRef.current.play();
                        }
                    }}
                />
                <div className="absolute top-3 left-3 flex gap-2">
                    {/* Stays the clip's own number, not its rank: the cards are
                        ordered by score, but this is what the downloaded file
                        is called (clip-N.mp4) and what every api call indexes. */}
                    <span className="bg-black/70 text-ink font-mono text-micro uppercase px-2 py-1 rounded-full">
                        Clip {index + 1}
                    </span>
                    {/* A bare number on a thumbnail reads as a duration, a
                        position, anything — it has to name itself and carry
                        its scale, or it is decoration. */}
                    {Number.isFinite(clip.predicted_score) && (
                        <span
                            className="bg-black/70 font-mono text-micro uppercase px-2 py-1 rounded-full flex items-center gap-1"
                            title="openshorts' prediction of how well this clip will perform, from 0 to 100"
                        >
                            <TrendingUp size={11} className="shrink-0 text-muted" />
                            <span className="text-muted">viral</span>
                            <b className={
                                clip.predicted_score >= 80 ? 'text-ok'
                                    : clip.predicted_score >= 65 ? 'text-brass'
                                        : 'text-ink2'
                            }>
                                {clip.predicted_score}
                            </b>
                            <span className="text-muted">/100</span>
                        </span>
                    )}
                </div>

                {/* Auto Edit Overlay if Processing */}
                {isEditing && (
                    <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center z-10 p-4 text-center">
                        <Loader2 size={28} className="text-brass animate-spin mb-3" />
                        <span className="text-xs text-ink lowercase">ai magic in progress…</span>
                        <span className="readout mt-1.5">APPLYING VIRAL EDITS · ZOOMS</span>
                    </div>
                )}
            </div>

            {/* Right: Content & Details */}
            <div className="flex-1 p-5 flex flex-col justify-between overflow-hidden min-w-0 bg-gradient-to-b from-paper2 to-paper3/30">
                <div>
                    <div className="mb-2">
                        <h3 className="text-base sm:text-lg font-bold text-ink leading-snug line-clamp-2 hover:text-brass transition-colors tracking-tight" title={clip.video_title_for_youtube_short}>
                            {clip.video_title_for_youtube_short || clip.video_title_for_facebook || "Clip Viral"}
                        </h3>
                    </div>

                    {clip.why && (
                        <div className="mb-3 px-3 py-2 rounded-xl bg-paper/60 border border-rule/60 text-xs text-muted flex items-start gap-2">
                            <Sparkles size={14} className="text-brass shrink-0 mt-0.5" />
                            <span className="line-clamp-2 italic leading-relaxed">{clip.why}</span>
                        </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2 mb-3.5">
                        {durationReadout && (
                            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-paper3 border border-rule text-ink2">
                                ⏱️ {durationReadout}
                            </span>
                        )}
                        {resolution && (
                            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-paper3 border border-rule text-ink2">
                                {resolution}
                            </span>
                        )}
                        {isPro && (
                            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-brass/10 border border-brass/30 text-brass">
                                Pro Mode
                            </span>
                        )}
                    </div>

                    {/* Social Media Copy Selector (Clean Tabs replacing the 3 stacked inputs) */}
                    <div className="rounded-xl border border-rule/80 bg-paper/90 p-3 mb-3 shadow-sm">
                        <div className="flex items-center justify-between gap-2 mb-2 pb-2 border-b border-rule/50">
                            <div className="flex items-center gap-1.5">
                                <button
                                    type="button"
                                    onClick={() => setSocialTab('facebook')}
                                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${socialTab === 'facebook' ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30' : 'text-muted hover:text-ink'}`}
                                >
                                    Facebook
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setSocialTab('tiktok')}
                                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${socialTab === 'tiktok' ? 'bg-pink-500/20 text-pink-400 border border-pink-500/30' : 'text-muted hover:text-ink'}`}
                                >
                                    TikTok
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setSocialTab('instagram')}
                                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${socialTab === 'instagram' ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30' : 'text-muted hover:text-ink'}`}
                                >
                                    Instagram
                                </button>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => {
                                        const txt = socialTab === 'facebook'
                                            ? (clip.video_title_for_facebook ? `${clip.video_title_for_facebook}\n\n${clip.video_description_for_facebook || ''}` : (clip.video_description_for_facebook || clip.video_description_for_tiktok))
                                            : socialTab === 'tiktok'
                                            ? (clip.video_title_for_tiktok ? `${clip.video_title_for_tiktok} — ` : '') + (clip.video_description_for_tiktok || clip.video_description_for_instagram)
                                            : (clip.video_title_for_instagram ? `${clip.video_title_for_instagram} — ` : '') + (clip.video_description_for_instagram || clip.video_description_for_tiktok);
                                        handleCopy(socialTab, txt);
                                    }}
                                    className="px-2.5 py-1 rounded-lg bg-paper3 hover:bg-paper2 border border-rule text-xs font-medium text-ink flex items-center gap-1.5 transition-all cursor-pointer"
                                >
                                    {copied === socialTab ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
                                    <span>{copied === socialTab ? '¡Copiado!' : 'Copiar'}</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setShowDescModal(true)}
                                    className="text-xs text-muted hover:text-brass p-1 transition-colors"
                                    title="Ver todos los textos completos"
                                >
                                    <FileText size={14} />
                                </button>
                            </div>
                        </div>
                        <p className="text-xs text-ink2 line-clamp-2 leading-relaxed">
                            {socialTab === 'facebook'
                                ? (clip.video_title_for_facebook || clip.video_description_for_facebook || clip.video_title_for_youtube_short)
                                : socialTab === 'tiktok'
                                ? (clip.video_title_for_tiktok ? `${clip.video_title_for_tiktok} — ` : '') + (clip.video_description_for_tiktok || clip.video_description_for_instagram)
                                : (clip.video_title_for_instagram ? `${clip.video_title_for_instagram} — ` : '') + (clip.video_description_for_instagram || clip.video_description_for_tiktok)}
                        </p>
                    </div>

                    {/* Error Message */}
                    {editError && (
                        <div className="mb-3 px-3 py-2 rounded-input text-xs text-danger bg-[color-mix(in_oklab,var(--color-danger)_10%,transparent)] flex items-center gap-2">
                            <AlertCircle size={14} className="shrink-0" />
                            {editError}
                        </div>
                    )}
                </div>

                {/* Actions Footer */}
                <div className="space-y-2.5 mt-auto pt-3 border-t border-rule/50">
                    {/* Grid of AI/Editing Tools (Clean 3-column grid) */}
                    <div className="grid grid-cols-3 gap-1.5">
                        {onEditClip && (
                            <button
                                onClick={() => onEditClip(index)}
                                className="py-2 px-2 rounded-lg border border-rule/70 bg-paper/70 hover:bg-paper3 text-xs text-ink font-medium flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                            >
                                <Scissors size={13} className="text-brass shrink-0" />
                                <span>Recortar</span>
                            </button>
                        )}
                        {onReframeClip && (
                            <button
                                onClick={() => onReframeClip(index)}
                                className="py-2 px-2 rounded-lg border border-rule/70 bg-paper/70 hover:bg-paper3 text-xs text-ink font-medium flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                            >
                                <Crosshair size={13} className="text-brass shrink-0" />
                                <span>Reencuadre</span>
                            </button>
                        )}
                        <button
                            onClick={() => setShowSubtitleModal(true)}
                            disabled={isSubtitling}
                            className="py-2 px-2 rounded-lg border border-rule/70 bg-paper/70 hover:bg-paper3 text-xs text-ink font-medium flex items-center justify-center gap-1.5 transition-all cursor-pointer disabled:opacity-50"
                        >
                            {isSubtitling ? <Loader2 size={13} className="animate-spin text-brass shrink-0" /> : <Type size={13} className="text-brass shrink-0" />}
                            <span>Subtítulos</span>
                        </button>
                        <button
                            onClick={() => setShowHookModal(true)}
                            disabled={isHooking}
                            className="py-2 px-2 rounded-lg border border-rule/70 bg-paper/70 hover:bg-paper3 text-xs text-ink font-medium flex items-center justify-center gap-1.5 transition-all cursor-pointer disabled:opacity-50"
                        >
                            {isHooking ? <Loader2 size={13} className="animate-spin text-brass shrink-0" /> : <Wand2 size={13} className="text-brass shrink-0" />}
                            <span>Gancho</span>
                        </button>
                        <button
                            onClick={() => setShowTranslateModal(true)}
                            disabled={isTranslating}
                            className="py-2 px-2 rounded-lg border border-rule/70 bg-paper/70 hover:bg-paper3 text-xs text-ink font-medium flex items-center justify-center gap-1.5 transition-all cursor-pointer disabled:opacity-50"
                        >
                            {isTranslating ? <Loader2 size={13} className="animate-spin text-brass shrink-0" /> : <Languages size={13} className="text-brass shrink-0" />}
                            <span>Doblaje</span>
                        </button>
                        {canSwitchMode && (
                            <button
                                onClick={handleMode}
                                disabled={isSwitchingMode}
                                className={`py-2 px-2 rounded-lg border text-xs font-medium flex items-center justify-center gap-1.5 transition-all cursor-pointer disabled:opacity-50 ${isPro ? 'border-brass bg-brass/15 text-brass' : 'border-rule/70 bg-paper/70 text-muted hover:text-ink'}`}
                                title="Modo Pro: encuadre cerrado para podcasts"
                            >
                                <Sparkles size={13} className={isPro ? 'text-brass shrink-0' : 'text-muted shrink-0'} />
                                <span>{isPro ? 'Pro ON' : 'Modo Pro'}</span>
                            </button>
                        )}
                    </div>

                    {/* Primary CTAs: Download & Publish in balanced grid */}
                    <div className="grid grid-cols-2 gap-2 pt-0.5">
                        <button
                            onClick={(e) => {
                                e.preventDefault();
                                if (plan === 'free' && !watermarkNoticeDismissed(jobId)) {
                                    setShowWatermarkModal(true);
                                    return;
                                }
                                downloadClip();
                            }}
                            className="py-2.5 px-3 rounded-xl border border-rule bg-paper3 hover:bg-paper2 text-xs font-semibold text-ink flex items-center justify-center gap-2 transition-all cursor-pointer shadow-xs"
                        >
                            <Download size={14} className="shrink-0" />
                            <span className="truncate">{downloadPct === null ? 'Descargar Clip' : `${downloadPct}%`}</span>
                        </button>
                        <button
                            onClick={() => setShowModal(true)}
                            className="py-2.5 px-3 rounded-xl bg-brass hover:bg-brass-bright text-paper font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-brass/25 transition-all cursor-pointer"
                        >
                            <Share2 size={14} className="shrink-0" />
                            <span className="truncate">Publicar en Redes</span>
                        </button>
                    </div>
                </div>
            </div>

            {/* Descriptions Modal */}
            <Modal
                isOpen={showDescModal}
                onClose={() => setShowDescModal(false)}
                eyebrow="TEXTOS VIRALES GENERADOS"
                title="Títulos y Descripciones"
                size="md"
            >
                <div className="space-y-5">
                    {/* FACEBOOK SECTION */}
                    <div className="border border-sky-500/20 bg-sky-950/10 rounded-input p-3 space-y-3">
                        <div className="flex items-center justify-between gap-2 border-b border-sky-500/20 pb-2">
                            <span className="text-xs font-bold text-sky-400 flex items-center gap-1.5 uppercase tracking-wide">
                                📘 Facebook (Reels & Posts)
                            </span>
                            <button
                                onClick={() => handleCopy('facebook_all', `${clip.video_title_for_facebook || clip.video_title_for_youtube_short}\n\n${clip.video_description_for_facebook || clip.video_description_for_tiktok || ''}`)}
                                className="text-xs text-sky-400 hover:text-sky-300 flex items-center gap-1 transition-colors px-2 py-0.5 rounded bg-sky-500/10"
                            >
                                {copied === 'facebook_all' ? <Check size={12} className="text-ok" /> : <Copy size={12} />} copiar todo
                            </button>
                        </div>
                        <div>
                            <div className="flex items-center justify-between gap-2 mb-1">
                                <label className="text-[10px] text-muted uppercase font-semibold">Título para Facebook</label>
                                <button
                                    onClick={() => handleCopy('fb_title', clip.video_title_for_facebook || clip.video_title_for_youtube_short || '')}
                                    className="p-1 rounded text-muted hover:text-sky-400 transition-colors"
                                >
                                    {copied === 'fb_title' ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
                                </button>
                            </div>
                            <p className="text-xs text-ink2 select-all bg-paper rounded p-2 border border-rule">
                                {clip.video_title_for_facebook || clip.video_title_for_youtube_short || "Video Viral"}
                            </p>
                        </div>
                        <div>
                            <div className="flex items-center justify-between gap-2 mb-1">
                                <label className="text-[10px] text-muted uppercase font-semibold">Descripción / Post para Facebook</label>
                                <button
                                    onClick={() => handleCopy('fb_desc', clip.video_description_for_facebook || clip.video_description_for_tiktok || '')}
                                    className="p-1 rounded text-muted hover:text-sky-400 transition-colors"
                                >
                                    {copied === 'fb_desc' ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
                                </button>
                            </div>
                            <p className="text-xs text-ink2 select-all bg-paper rounded p-2 border border-rule whitespace-pre-wrap">
                                {clip.video_description_for_facebook || clip.video_description_for_tiktok || clip.video_description_for_instagram}
                            </p>
                        </div>
                    </div>

                    {/* TIKTOK SECTION */}
                    <div className="border border-pink-500/20 bg-pink-950/10 rounded-input p-3 space-y-3">
                        <div className="flex items-center justify-between gap-2 border-b border-pink-500/20 pb-2">
                            <span className="text-xs font-bold text-pink-400 flex items-center gap-1.5 uppercase tracking-wide">
                                🎵 TikTok
                            </span>
                            <button
                                onClick={() => handleCopy('tiktok_all', `${clip.video_title_for_tiktok ? clip.video_title_for_tiktok + '\n\n' : ''}${clip.video_description_for_tiktok || clip.video_description_for_instagram || ''}`)}
                                className="text-xs text-pink-400 hover:text-pink-300 flex items-center gap-1 transition-colors px-2 py-0.5 rounded bg-pink-500/10"
                            >
                                {copied === 'tiktok_all' ? <Check size={12} className="text-ok" /> : <Copy size={12} />} copiar todo
                            </button>
                        </div>
                        <div>
                            <div className="flex items-center justify-between gap-2 mb-1">
                                <label className="text-[10px] text-muted uppercase font-semibold">Título / Gancho para TikTok</label>
                                <button
                                    onClick={() => handleCopy('tt_title', clip.video_title_for_tiktok || clip.viral_hook_text || clip.video_title_for_youtube_short || '')}
                                    className="p-1 rounded text-muted hover:text-pink-400 transition-colors"
                                >
                                    {copied === 'tt_title' ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
                                </button>
                            </div>
                            <p className="text-xs text-ink2 select-all bg-paper rounded p-2 border border-rule">
                                {clip.video_title_for_tiktok || clip.viral_hook_text || clip.video_title_for_youtube_short || "Video Viral"}
                            </p>
                        </div>
                        <div>
                            <div className="flex items-center justify-between gap-2 mb-1">
                                <label className="text-[10px] text-muted uppercase font-semibold">Descripción & Hashtags para TikTok</label>
                                <button
                                    onClick={() => handleCopy('tt_desc', clip.video_description_for_tiktok || clip.video_description_for_instagram || '')}
                                    className="p-1 rounded text-muted hover:text-pink-400 transition-colors"
                                >
                                    {copied === 'tt_desc' ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
                                </button>
                            </div>
                            <p className="text-xs text-ink2 select-all bg-paper rounded p-2 border border-rule whitespace-pre-wrap">
                                {clip.video_description_for_tiktok || clip.video_description_for_instagram}
                            </p>
                        </div>
                    </div>

                    {/* INSTAGRAM SECTION */}
                    <div className="border border-purple-500/20 bg-purple-950/10 rounded-input p-3 space-y-3">
                        <div className="flex items-center justify-between gap-2 border-b border-purple-500/20 pb-2">
                            <span className="text-xs font-bold text-purple-400 flex items-center gap-1.5 uppercase tracking-wide">
                                📸 Instagram (Reels)
                            </span>
                            <button
                                onClick={() => handleCopy('ig_all', `${clip.video_title_for_instagram ? clip.video_title_for_instagram + '\n\n' : ''}${clip.video_description_for_instagram || clip.video_description_for_tiktok || ''}`)}
                                className="text-xs text-purple-400 hover:text-purple-300 flex items-center gap-1 transition-colors px-2 py-0.5 rounded bg-purple-500/10"
                            >
                                {copied === 'ig_all' ? <Check size={12} className="text-ok" /> : <Copy size={12} />} copiar todo
                            </button>
                        </div>
                        <div>
                            <div className="flex items-center justify-between gap-2 mb-1">
                                <label className="text-[10px] text-muted uppercase font-semibold">Título / Gancho para Instagram</label>
                                <button
                                    onClick={() => handleCopy('ig_title', clip.video_title_for_instagram || clip.video_title_for_tiktok || clip.viral_hook_text || '')}
                                    className="p-1 rounded text-muted hover:text-purple-400 transition-colors"
                                >
                                    {copied === 'ig_title' ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
                                </button>
                            </div>
                            <p className="text-xs text-ink2 select-all bg-paper rounded p-2 border border-rule">
                                {clip.video_title_for_instagram || clip.video_title_for_tiktok || clip.viral_hook_text || "Reel Viral"}
                            </p>
                        </div>
                        <div>
                            <div className="flex items-center justify-between gap-2 mb-1">
                                <label className="text-[10px] text-muted uppercase font-semibold">Descripción & Hashtags para Instagram</label>
                                <button
                                    onClick={() => handleCopy('ig_desc', clip.video_description_for_instagram || clip.video_description_for_tiktok || '')}
                                    className="p-1 rounded text-muted hover:text-purple-400 transition-colors"
                                >
                                    {copied === 'ig_desc' ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
                                </button>
                            </div>
                            <p className="text-xs text-ink2 select-all bg-paper rounded p-2 border border-rule whitespace-pre-wrap">
                                {clip.video_description_for_instagram || clip.video_description_for_tiktok}
                            </p>
                        </div>
                    </div>

                    {/* YOUTUBE SECTION */}
                    <div>
                        <div className="flex items-center justify-between gap-2 mb-1.5">
                            <label className="eyebrow">TÍTULO YOUTUBE SHORTS</label>
                            <button
                                onClick={() => handleCopy('youtube', clip.video_title_for_youtube_short || "Viral Short Video")}
                                aria-label="copiar título de youtube"
                                className="p-1 rounded-full text-muted hover:text-brass transition-colors shrink-0"
                            >
                                {copied === 'youtube' ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
                            </button>
                        </div>
                        <p className="text-xs text-ink2 select-all break-words bg-paper rounded-input p-2.5 border border-rule">
                            {clip.video_title_for_youtube_short || "Viral Short Video"}
                        </p>
                    </div>
                </div>
            </Modal>

            {/* Post Modal */}
            <Modal
                isOpen={showModal}
                onClose={() => setShowModal(false)}
                eyebrow="PUBLICAR O PREPARAR"
                title="Publicar en Redes Sociales"
                size="md"
                footer={
                    noAccountsConnected ? (
                        <button onClick={handleConnectAccounts} className="btn-primary w-full">
                            <Link2 size={16} /> connect accounts
                        </button>
                    ) : (
                        <button
                            onClick={handlePost}
                            disabled={posting || !canPost}
                            className="btn-primary w-full"
                        >
                            {posting ? <><Loader2 size={16} className="animate-spin" /> {isScheduling ? 'scheduling…' : 'publishing…'}</> : <><Share2 size={16} /> {isScheduling ? 'schedule post' : 'publish now'}</>}
                        </button>
                    )
                }
            >
                {/* CDP Browser Fast Publisher Section */}
                <div className="p-3.5 mb-4 rounded-input border border-brass/40 bg-brass/5 space-y-3">
                    <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-brass uppercase tracking-wide flex items-center gap-1.5">
                            ⚡ Publicar Automático en Redes (1 Clic)
                        </span>
                        <span className="text-[10px] text-muted">Sube el video y publica solo</span>
                    </div>
                    <p className="text-xs text-ink2">
                        El bot toma el video, escribe el título y hashtags virales de GTA 6 y lo publica directamente en tu página:
                    </p>
                    <div className="grid grid-cols-3 gap-2">
                        <button
                            type="button"
                            disabled={browserPosting !== null}
                            onClick={() => handleBrowserOpen('facebook')}
                            className="flex items-center justify-center gap-1.5 py-2.5 px-2 rounded bg-sky-500/10 hover:bg-sky-500/20 text-sky-400 border border-sky-500/30 text-xs font-semibold transition-all disabled:opacity-50"
                        >
                            {browserPosting === 'facebook' ? <Loader2 size={13} className="animate-spin" /> : <span>📘 Facebook</span>}
                        </button>
                        <button
                            type="button"
                            disabled={browserPosting !== null}
                            onClick={() => handleBrowserOpen('instagram')}
                            className="flex items-center justify-center gap-1.5 py-2.5 px-2 rounded bg-purple-500/10 hover:bg-purple-500/20 text-purple-400 border border-purple-500/30 text-xs font-semibold transition-all disabled:opacity-50"
                        >
                            {browserPosting === 'instagram' ? <Loader2 size={13} className="animate-spin" /> : <span>📸 Instagram</span>}
                        </button>
                        <button
                            type="button"
                            disabled={browserPosting !== null}
                            onClick={() => handleBrowserOpen('tiktok')}
                            className="flex items-center justify-center gap-1.5 py-2.5 px-2 rounded bg-pink-500/10 hover:bg-pink-500/20 text-pink-400 border border-pink-500/30 text-xs font-semibold transition-all disabled:opacity-50"
                        >
                            {browserPosting === 'tiktok' ? <Loader2 size={13} className="animate-spin" /> : <span>🎵 TikTok</span>}
                        </button>
                    </div>
                    {browserMsg && (
                        <div className="text-xs p-2.5 rounded bg-paper border border-rule text-ink2">
                            {browserMsg}
                        </div>
                    )}
                </div>
                {!canPost && (
                    <div className="mb-4 px-3 py-2 rounded-input text-xs text-warn bg-[color-mix(in_oklab,var(--color-warn)_10%,transparent)] flex items-start gap-2">
                        <AlertCircle size={14} className="mt-0.5 shrink-0" />
                        <div className="lowercase">configure api key in settings first.</div>
                    </div>
                )}

                {noAccountsConnected && (
                    <div className="mb-4 px-3 py-2 rounded-input text-xs text-warn bg-[color-mix(in_oklab,var(--color-warn)_10%,transparent)] flex items-start gap-2">
                        <AlertCircle size={14} className="mt-0.5 shrink-0" />
                        <div className="lowercase">no social accounts connected yet — link tiktok, instagram, youtube, facebook, linkedin, threads or bluesky to publish this clip.</div>
                    </div>
                )}

                {/* Both the title/description fields below and the schedule
                    button are downstream of this: on a tiktok draft neither
                    travels. See TikTokDraftNotice. */}
                {platforms.tiktok && <TikTokDraftNotice />}

                <div className="space-y-4">
                    {/* Title & Description */}
                    <div>
                        <label className="eyebrow block mb-1.5">TITLE</label>
                        <input
                            type="text"
                            value={postTitle}
                            onChange={(e) => setPostTitle(e.target.value)}
                            className="input-field"
                            placeholder="enter a catchy title…"
                        />
                    </div>

                    <div>
                        <label className="eyebrow block mb-1.5">CAPTION</label>
                        <textarea
                            value={postDescription}
                            onChange={(e) => setPostDescription(e.target.value)}
                            rows={4}
                            className="input-field resize-none"
                            placeholder="write a caption for your post…"
                        />
                    </div>

                    {/* Scheduling */}
                    <div className="p-3 bg-paper rounded-input border border-rule">
                        <label className="flex items-center justify-between cursor-pointer">
                            <span className="flex items-center gap-2 text-sm text-ink2 lowercase">
                                <Calendar size={16} className={isScheduling ? 'text-brass' : 'text-muted'} /> schedule post
                            </span>
                            <input
                                type="checkbox"
                                checked={isScheduling}
                                onChange={(e) => setIsScheduling(e.target.checked)}
                                className="w-4 h-4 accent-brass cursor-pointer"
                            />
                        </label>

                        {isScheduling && (
                            <div className="mt-3 animate-fade">
                                <label className="eyebrow block mb-1.5">DATE · TIME</label>
                                <input
                                    type="datetime-local"
                                    value={scheduleDate}
                                    onChange={(e) => setScheduleDate(e.target.value)}
                                    className="input-field [color-scheme:dark]"
                                />
                            </div>
                        )}
                    </div>

                    {/* Platforms */}
                    <div>
                        <label className="eyebrow block mb-2">PLATFORMS</label>
                        <SegmentedControl
                            multi
                            columns={4}
                            options={platformOptions}
                            value={Object.keys(platforms).filter(k => platforms[k])}
                            onChange={(arr) => setPlatforms(flagsFromList(arr))}
                        />
                    </div>

                    {postResult && (
                        <div className={postResult.success ? 'badge-ok' : 'badge-danger'}>
                            {postResult.success ? <Check size={12} className="shrink-0" /> : <AlertCircle size={12} className="shrink-0" />}
                            {postResult.msg}
                        </div>
                    )}
                </div>
            </Modal>

            <SubtitleModal
                isOpen={showSubtitleModal}
                onClose={() => setShowSubtitleModal(false)}
                onGenerate={handleSubtitle}
                onApplyAll={onBulkSubtitle ? async (options) => {
                    await onBulkSubtitle(options);
                    setShowSubtitleModal(false);
                } : undefined}
                onRemove={handleRemoveSubtitles}
                bulkCount={clipCount}
                bulkProgress={bulkProgress}
                isProcessing={isSubtitling || (bulkProgress?.running ?? false)}
                videoUrl={originalVideoUrl}
                jobId={jobId}
                clipIndex={index}
                existingHook={activeLayers.hook}
            />

            <HookModal
                isOpen={showHookModal}
                onClose={() => setShowHookModal(false)}
                onGenerate={handleHook}
                isProcessing={isHooking}
                videoUrl={originalVideoUrl}
                initialText={clip.viral_hook_text}
                durationInSeconds={clip.end && clip.start ? clip.end - clip.start : 30}
                existingSubtitles={activeLayers.subtitles}
                hasCaptions={!!activeLayers.subtitles || /(^|_)subtitled_/.test(serverVideoFile || '')}
                serverRender={hasServerBurns}
                burnedHook={burnedHook}
                onRemove={burnedHook ? handleRemoveHook : null}
            />

            <TranslateModal
                isOpen={showTranslateModal}
                onClose={() => setShowTranslateModal(false)}
                onTranslate={handleTranslate}
                isProcessing={isTranslating}
                videoUrl={currentVideoUrl}
                hasApiKey={!!elevenLabsKey}
            />

            {showWatermarkModal && (
                <WatermarkModal
                    source="download"
                    jobId={jobId}
                    onUpgrade={onUpgrade}
                    onClose={() => setShowWatermarkModal(false)}
                    onContinue={downloadClip}
                />
            )}

        </div>
    );
}
