import React, { useState, useEffect, useRef } from 'react';
import { 
  Bot, Send, Plus, Trash2, Loader2, Sparkles, 
  Clock, CheckCircle2, AlertCircle, RefreshCw, FileVideo, 
  ChevronRight, MessageSquare, Film, ArrowRight, CornerDownLeft,
  ExternalLink, Check, SlidersHorizontal, Settings2
} from 'lucide-react';
import { getApiUrl } from '../config';
import { apiFetch } from '../lib/api';

/**
 * Format markdown-like text with bold, bullet points, and code spans
 */
function FormattedMessage({ text }) {
  if (!text) return null;

  const lines = text.split('\n');
  return (
    <div className="space-y-1.5 leading-relaxed text-sm">
      {lines.map((line, idx) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return <div key={idx} className="h-2" />;
        }

        const isBullet = trimmed.startsWith('•') || trimmed.startsWith('- ') || trimmed.startsWith('* ');
        const content = isBullet ? trimmed.replace(/^([•*-]\s*)/, '') : line;

        const parts = [];
        const regex = /(\*\*.*?\*\*|`.*?`)/g;
        let lastIdx = 0;
        let match;

        while ((match = regex.exec(content)) !== null) {
          if (match.index > lastIdx) {
            parts.push(content.substring(lastIdx, match.index));
          }
          const token = match[0];
          if (token.startsWith('**') && token.endsWith('**')) {
            parts.push(<strong key={match.index} className="font-semibold text-ink">{token.slice(2, -2)}</strong>);
          } else if (token.startsWith('`') && token.endsWith('`')) {
            parts.push(<code key={match.index} className="px-1.5 py-0.5 rounded bg-paper3 text-brass font-mono text-xs">{token.slice(1, -1)}</code>);
          }
          lastIdx = regex.lastIndex;
        }
        if (lastIdx < content.length) {
          parts.push(content.substring(lastIdx));
        }

        if (isBullet) {
          return (
            <div key={idx} className="flex items-start gap-2 pl-2">
              <span className="text-brass select-none mt-1 leading-none text-xs">●</span>
              <span className="flex-1">{parts}</span>
            </div>
          );
        }

        return <p key={idx}>{parts}</p>;
      })}
    </div>
  );
}

/**
 * Compact Job Card (Fase 4 & 7):
 * Chat is the command center, not the detailed progress visualizer.
 * Displays job summary and button to navigate to Clip Generator.
 */
function CompactJobCard({ task, onViewJobInGenerator, onRefreshJob }) {
  if (!task) return null;

  const toolName = task.tool_name || '';
  const params = task.parameters || {};
  const result = task.result || {};
  const liveJob = task.live_job || {};

  const jobId = task.job_id || params.job_id || result.job_id;
  const status = liveJob.status || task.status || result.status || 'queued';
  const targetClips = params.target_clips || result.target_clips || (status === 'complete' ? (liveJob.result?.clips?.length || 2) : 2);
  const creativeStyle = params.creative_style || result.creative_style;

  const isComplete = status === 'complete' || status === 'completed';
  const isFailed = status === 'failed' || status === 'error';
  const isProcessing = status === 'processing' || status === 'running';
  const isQueued = status === 'queued' || status === 'pending';

  // For modify job tool
  if (toolName === 'tool_modify_job') {
    return (
      <div className="mt-2.5 p-3 rounded-card border border-rule bg-paper3/60 text-xs space-y-2">
        <div className="flex items-center gap-2 font-mono text-[11px] text-muted">
          <SlidersHorizontal size={13} className="text-brass" />
          <span>MODIFICACIÓN DE TRABAJO</span>
          {jobId && <span className="bg-paper2 px-1.5 py-0.5 rounded border border-rule">{jobId.slice(0, 8)}...</span>}
        </div>
        <p className="text-ink">{result.message || 'Solicitud de modificación procesada.'}</p>
        {jobId && onViewJobInGenerator && (
          <button
            onClick={() => onViewJobInGenerator(jobId)}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-input bg-paper2 hover:bg-paper3 border border-rule text-ink text-xs transition-colors"
          >
            <span>Ver en el Generador</span>
            <ExternalLink size={12} />
          </button>
        )}
      </div>
    );
  }

  // For preferences update
  if (toolName === 'tool_update_preferences') {
    return (
      <div className="mt-2.5 p-3 rounded-card border border-rule bg-paper3/60 text-xs flex items-center gap-2.5">
        <Settings2 size={15} className="text-brass shrink-0" />
        <span className="text-ink">Preferencias de generación guardadas para futuros trabajos en esta conversación.</span>
      </div>
    );
  }

  // Standard Job Card for tool_create_shorts or tool_get_job_status
  return (
    <div className="mt-2.5 p-3.5 rounded-card border border-rule bg-paper3/70 space-y-3 shadow-sm max-w-md">
      {/* Top row: Identity and Status badge */}
      <div className="flex items-center justify-between gap-2 border-b border-rule/50 pb-2">
        <div className="flex items-center gap-2 min-w-0">
          <Film size={15} className="text-brass shrink-0" />
          <span className="text-xs font-semibold text-ink truncate">
            {isComplete ? 'Shorts generados' : 'Trabajo en OpenShorts'}
          </span>
          {jobId && (
            <span className="text-[10px] font-mono text-muted bg-paper2 px-1.5 py-0.5 rounded border border-rule shrink-0">
              {jobId.slice(0, 8)}...
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded flex items-center gap-1 ${
            isComplete
              ? 'bg-ok/15 text-ok'
              : isFailed
              ? 'bg-err/15 text-err'
              : isProcessing
              ? 'bg-sky-500/15 text-sky-400'
              : 'bg-brass/15 text-brass'
          }`}>
            {isProcessing && <Loader2 size={10} className="animate-spin" />}
            {isQueued && <Clock size={10} />}
            {isComplete && <Check size={10} />}
            {isFailed && <AlertCircle size={10} />}
            <span>{isComplete ? 'Completado' : isProcessing ? 'Procesando' : isQueued ? 'En cola' : 'Fallido'}</span>
          </span>

          {jobId && onRefreshJob && (
            <button
              onClick={() => onRefreshJob(jobId)}
              title="Comprobar estado actual"
              className="p-1 rounded hover:bg-paper2 text-muted hover:text-ink transition-colors"
            >
              <RefreshCw size={11} className={isProcessing ? 'animate-spin' : ''} />
            </button>
          )}
        </div>
      </div>

      {/* Middle row: Parameters summary */}
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
        <span className="px-2 py-0.5 rounded bg-paper2 border border-rule/80">
          🎯 {targetClips} {targetClips === 1 ? 'clip' : 'clips'}
        </span>
        {creativeStyle && (
          <span className="px-2 py-0.5 rounded bg-brass/10 border border-brass/20 text-brass font-medium capitalize">
            ✨ {creativeStyle}
          </span>
        )}
        <span className="px-2 py-0.5 rounded bg-paper2 border border-rule/80">
          📱 9:16 Vertical
        </span>
      </div>

      {/* Action button: Navigate to Clip Generator */}
      {jobId && onViewJobInGenerator && (
        <button
          onClick={() => onViewJobInGenerator(jobId)}
          className={`w-full flex items-center justify-center gap-2 py-2 px-3 rounded-input text-xs font-semibold transition-all ${
            isComplete
              ? 'bg-brass hover:bg-brass/90 text-paper shadow-sm'
              : 'bg-paper2 hover:bg-brass hover:text-paper border border-rule text-ink'
          }`}
        >
          <span>{isComplete ? 'Ver y descargar clips en el Generador' : 'Ver progreso en el Generador'}</span>
          <ArrowRight size={13} />
        </button>
      )}
    </div>
  );
}

export default function AiAssistantTab({ onViewJobInGenerator }) {
  const [conversations, setConversations] = useState([]);
  const [activeConvId, setActiveConvId] = useState(null);
  const [activeContext, setActiveContext] = useState(null);
  const [messages, setMessages] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [inputText, setInputText] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isThinking]);

  // Load conversations on mount
  const loadConversations = async () => {
    try {
      const res = await apiFetch('/api/assistant/conversations');
      if (res.ok) {
        const data = await res.json();
        const list = data.conversations || [];
        setConversations(list);
        if (list.length > 0 && !activeConvId) {
          selectConversation(list[0].id);
        }
      }
    } catch (err) {
      console.error('Error fetching conversations:', err);
    }
  };

  useEffect(() => {
    loadConversations();
  }, []);

  // Select conversation and load thread & context
  const selectConversation = async (convId) => {
    setActiveConvId(convId);
    setSidebarOpen(false);
    try {
      const res = await apiFetch(`/api/assistant/conversations/${convId}`);
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages || []);
        setTasks(data.tasks || []);
        setActiveContext(data.context || null);
      }
    } catch (err) {
      console.error('Error fetching conversation:', err);
    }
  };

  // Create new conversation
  const createNewConversation = async () => {
    try {
      const res = await apiFetch('/api/assistant/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Nueva conversación' }),
      });
      if (res.ok) {
        const data = await res.json();
        const newConv = data.conversation;
        setConversations((prev) => [newConv, ...prev]);
        setActiveConvId(newConv.id);
        setMessages([]);
        setTasks([]);
        setActiveContext(newConv.context || null);
        setSidebarOpen(false);
      }
    } catch (err) {
      console.error('Error creating conversation:', err);
    }
  };

  // Delete conversation
  const deleteConversation = async (convId, e) => {
    e.stopPropagation();
    if (!window.confirm('¿Deseas eliminar esta conversación?')) return;
    try {
      const res = await apiFetch(`/api/assistant/conversations/${convId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        const remaining = conversations.filter((c) => c.id !== convId);
        setConversations(remaining);
        if (activeConvId === convId) {
          if (remaining.length > 0) {
            selectConversation(remaining[0].id);
          } else {
            setActiveConvId(null);
            setMessages([]);
            setTasks([]);
            setActiveContext(null);
          }
        }
      }
    } catch (err) {
      console.error('Error deleting conversation:', err);
    }
  };

  // Lightweight check of job status for a card
  const refreshJobStatus = async (jobId) => {
    try {
      const res = await apiFetch(`/api/assistant/jobs/${jobId}/status`);
      if (res.ok) {
        const updatedJob = await res.json();
        setTasks((prev) =>
          prev.map((t) => (t.job_id === jobId ? { ...t, live_job: updatedJob } : t))
        );
      }
    } catch (err) {
      console.error('Error refreshing job:', err);
    }
  };

  // Send message
  const handleSendMessage = async (textToSend) => {
    const prompt = (textToSend || inputText).trim();
    if (!prompt || isThinking) return;

    setInputText('');
    let convId = activeConvId;

    const tempUserMsg = {
      id: 'temp-' + Date.now(),
      sender: 'user',
      content: prompt,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUserMsg]);
    setIsThinking(true);

    try {
      const res = await apiFetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: convId,
          message: prompt,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ detail: 'Error en el servidor' }));
        throw new Error(errData.detail || 'Error en la solicitud');
      }

      const data = await res.json();
      const confirmedConvId = data.conversation_id;

      if (!convId && confirmedConvId) {
        setActiveConvId(confirmedConvId);
        loadConversations();
      }

      setMessages((prev) => {
        const filtered = prev.filter((m) => m.id !== tempUserMsg.id);
        return [...filtered, data.user_message, data.assistant_message];
      });

      if (data.task) {
        setTasks((prev) => {
          const exists = prev.some((t) => t.id === data.task.id);
          if (exists) {
            return prev.map((t) => (t.id === data.task.id ? data.task : t));
          }
          return [...prev, data.task];
        });
      }

      // Re-fetch conversation context to keep chips and state synchronized
      if (confirmedConvId) {
        try {
          const ctxRes = await apiFetch(`/api/assistant/conversations/${confirmedConvId}/context`);
          if (ctxRes.ok) {
            const ctxData = await ctxRes.json();
            setActiveContext(ctxData.context || null);
          }
        } catch (_) {}
      }

    } catch (err) {
      console.error('Error in chat turn:', err);
      setMessages((prev) => [
        ...prev,
        {
          id: 'err-' + Date.now(),
          sender: 'assistant',
          content: `⚠️ Ocurrió un error al procesar tu solicitud: ${err.message}`,
          created_at: new Date().toISOString(),
        },
      ]);
    } finally {
      setIsThinking(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const getTaskForMessage = (msg) => {
    if (!msg.tool_calls || !msg.tool_calls.length) return null;
    const call = msg.tool_calls[0];
    const taskId = call.task_id;
    return tasks.find((t) => t.id === taskId) || null;
  };

  const activeConv = conversations.find((c) => c.id === activeConvId);
  const hasSource = Boolean(activeContext?.last_source_url);

  return (
    <div className="h-[calc(100vh-64px)] flex overflow-hidden bg-paper">
      {/* Sidebar - Desktop and Mobile Drawer */}
      <div
        className={`fixed inset-y-0 left-0 z-40 w-72 bg-paper2 border-r border-rule transform transition-transform duration-200 ease-in-out md:relative md:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        } flex flex-col`}
      >
        {/* Sidebar Header */}
        <div className="p-4 border-b border-rule flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-input bg-brass/10 text-brass">
              <Bot size={18} />
            </div>
            <span className="font-display font-medium text-sm text-ink lowercase">AI Assistant</span>
          </div>

          <button
            onClick={createNewConversation}
            className="p-1.5 rounded-input bg-paper3 hover:bg-brass hover:text-paper text-ink transition-colors flex items-center gap-1 text-xs"
            title="Nueva conversación"
          >
            <Plus size={14} />
            <span className="hidden sm:inline lowercase text-[11px]">nuevo</span>
          </button>
        </div>

        {/* Conversation List */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
          {conversations.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted">
              No hay conversaciones activas. Inicia una nueva arriba.
            </div>
          ) : (
            conversations.map((conv) => {
              const isActive = conv.id === activeConvId;
              return (
                <div
                  key={conv.id}
                  onClick={() => selectConversation(conv.id)}
                  className={`group w-full flex items-center justify-between px-3 py-2.5 rounded-input text-xs cursor-pointer transition-colors ${
                    isActive
                      ? 'bg-paper3 text-ink font-medium border border-rule'
                      : 'text-muted hover:text-ink2 hover:bg-paper3/50'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
                    <MessageSquare size={13} className={isActive ? 'text-brass shrink-0' : 'shrink-0 opacity-60'} />
                    <span className="truncate">{conv.title || 'Conversación'}</span>
                  </div>
                  <button
                    onClick={(e) => deleteConversation(conv.id, e)}
                    className="opacity-0 group-hover:opacity-100 hover:text-err p-1 rounded transition-opacity"
                    title="Eliminar conversación"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })
          )}
        </div>

        {/* Context Summary in Sidebar Footer */}
        <div className="p-3 border-t border-rule bg-paper3/30 text-[11px] text-muted space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-ok animate-pulse" />
              AGY ACP Activo
            </span>
            <span className="font-mono text-[10px]">v1.5.1</span>
          </div>
          {hasSource && (
            <p className="text-[10px] text-brass/90 truncate font-mono" title={activeContext.last_source_url}>
              🔗 {activeContext.last_source_url}
            </p>
          )}
        </div>
      </div>

      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 bg-black/40 z-30 md:hidden"
        />
      )}

      {/* Main Chat Workspace */}
      <div className="flex-1 flex flex-col min-w-0 bg-paper">
        {/* Chat Header */}
        <div className="h-14 px-4 border-b border-rule bg-paper2/50 backdrop-blur-sm flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(true)}
              className="md:hidden p-1.5 rounded bg-paper3 text-ink"
              title="Abrir menú"
            >
              <MessageSquare size={16} />
            </button>
            <div>
              <h2 className="text-sm font-semibold text-ink lowercase truncate max-w-xs sm:max-w-md">
                {activeConv?.title || 'OpenShorts AI Assistant'}
              </h2>
              <p className="text-[11px] text-muted flex items-center gap-1.5">
                <Sparkles size={11} className="text-brass" /> Centro de mando inteligente con Google Antigravity
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="hidden sm:inline-block px-2 py-0.5 rounded bg-paper3 border border-rule text-[11px] text-muted font-mono">
              Centro de Mando
            </span>
          </div>
        </div>

        {/* Message Thread */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-4 md:p-6 space-y-4">
          {messages.length === 0 && !isThinking ? (
            /* Empty State */
            <div className="h-full flex flex-col items-center justify-center text-center max-w-lg mx-auto p-4 space-y-6">
              <div className="w-14 h-14 rounded-full bg-brass/10 border border-brass/20 flex items-center justify-center text-brass shadow-sm">
                <Bot size={28} />
              </div>
              <div className="space-y-2">
                <h3 className="font-display lowercase text-xl text-ink font-semibold">
                  Centro de mando OpenShorts
                </h3>
                <p className="text-xs text-muted leading-relaxed">
                  Soy tu colaborador de IA. Comprendo el contexto de tus vídeos, recuerdo las fuentes utilizadas y organizo tus trabajos de edición y estilo mientras OpenShorts los procesa.
                </p>
              </div>

              {/* Suggestions */}
              <div className="w-full space-y-2 pt-2">
                <p className="text-[11px] uppercase tracking-wider text-muted font-mono">Acciones rápidas</p>
                <div className="flex flex-col gap-2">
                  <button
                    onClick={() => setInputText('Genera 2 shorts virales a partir de este vídeo: ')}
                    className="p-2.5 rounded-input border border-rule bg-paper2 hover:bg-paper3 text-xs text-left text-ink transition-colors flex items-center justify-between group"
                  >
                    <span>🎬 Crear Shorts con un enlace de YouTube...</span>
                    <CornerDownLeft size={13} className="text-muted group-hover:text-brass transition-colors" />
                  </button>
                  <button
                    onClick={() => handleSendMessage('¿Cuáles son mis proyectos o trabajos recientes en OpenShorts?')}
                    className="p-2.5 rounded-input border border-rule bg-paper2 hover:bg-paper3 text-xs text-left text-ink transition-colors flex items-center justify-between group"
                  >
                    <span>📁 Ver mis proyectos recientes</span>
                    <ChevronRight size={13} className="text-muted group-hover:text-brass transition-colors" />
                  </button>
                  <button
                    onClick={() => handleSendMessage('¿Qué estilos creativos puedes aplicar al seleccionar momentos virales?')}
                    className="p-2.5 rounded-input border border-rule bg-paper2 hover:bg-paper3 text-xs text-left text-ink transition-colors flex items-center justify-between group"
                  >
                    <span>✨ Consultar estilos creativos disponibles</span>
                    <ChevronRight size={13} className="text-muted group-hover:text-brass transition-colors" />
                  </button>
                </div>
              </div>
            </div>
          ) : (
            /* Message List */
            messages.map((msg, i) => {
              const isUser = msg.sender === 'user';
              const taskObj = !isUser ? getTaskForMessage(msg) : null;

              return (
                <div
                  key={msg.id || i}
                  className={`flex gap-3 max-w-3xl ${isUser ? 'ml-auto justify-end' : 'mr-auto justify-start'}`}
                >
                  {!isUser && (
                    <div className="w-8 h-8 rounded-full bg-paper3 border border-rule flex items-center justify-center text-brass shrink-0 mt-0.5">
                      <Bot size={16} />
                    </div>
                  )}

                  <div className={`space-y-1 max-w-[85%] sm:max-w-2xl`}>
                    <div
                      className={`p-3.5 rounded-card text-xs md:text-sm ${
                        isUser
                          ? 'bg-paper3 text-ink border border-rule ml-auto rounded-tr-sm'
                          : 'bg-paper2 text-ink border border-rule shadow-sm rounded-tl-sm'
                      }`}
                    >
                      <FormattedMessage text={msg.content} />
                    </div>

                    {/* Attached Compact Job Card */}
                    {taskObj && (
                      <CompactJobCard
                        task={taskObj}
                        onViewJobInGenerator={onViewJobInGenerator}
                        onRefreshJob={refreshJobStatus}
                      />
                    )}

                    <p className={`text-[10px] text-muted px-1 ${isUser ? 'text-right' : 'text-left'}`}>
                      {msg.created_at ? new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                    </p>
                  </div>

                  {isUser && (
                    <div className="w-8 h-8 rounded-full bg-brass/15 text-brass border border-brass/30 flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">
                      Tú
                    </div>
                  )}
                </div>
              );
            })
          )}

          {/* Thinking indicator */}
          {isThinking && (
            <div className="flex gap-3 max-w-xl mr-auto animate-fade">
              <div className="w-8 h-8 rounded-full bg-paper3 border border-rule flex items-center justify-center text-brass shrink-0">
                <Bot size={16} />
              </div>
              <div className="p-3.5 rounded-card bg-paper2 border border-rule text-xs text-muted flex items-center gap-2.5 shadow-sm">
                <Loader2 size={14} className="animate-spin text-brass" />
                <span className="italic">Antigravity ACP está razonando tu solicitud...</span>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Dynamic Contextual Quick Chips */}
        {hasSource && !isThinking && (
          <div className="px-4 py-1.5 flex items-center gap-2 overflow-x-auto custom-scrollbar border-t border-rule/50 bg-paper2/40">
            <span className="text-[10px] uppercase font-mono text-muted shrink-0">Sugerencias:</span>
            <button
              onClick={() => handleSendMessage('Genera otro clip de este vídeo, pero que sea un momento tenso')}
              className="text-[11px] px-2.5 py-1 rounded-full bg-paper3 hover:bg-brass hover:text-paper border border-rule text-ink transition-colors whitespace-nowrap shrink-0"
            >
              ⚡ Momento tenso
            </button>
            <button
              onClick={() => handleSendMessage('Sácame un clip con un momento divertido de la misma fuente')}
              className="text-[11px] px-2.5 py-1 rounded-full bg-paper3 hover:bg-brass hover:text-paper border border-rule text-ink transition-colors whitespace-nowrap shrink-0"
            >
              😄 Momento divertido
            </button>
            <button
              onClick={() => handleSendMessage('¿Cómo va el estado de mi último trabajo?')}
              className="text-[11px] px-2.5 py-1 rounded-full bg-paper3 hover:bg-brass hover:text-paper border border-rule text-ink transition-colors whitespace-nowrap shrink-0"
            >
              📊 Estado del trabajo
            </button>
          </div>
        )}

        {/* Input Bar */}
        <div className="p-3 sm:p-4 border-t border-rule bg-paper2/70 backdrop-blur-sm">
          <div className="max-w-3xl mx-auto flex items-end gap-2 bg-paper3/80 rounded-card p-2 border border-rule focus-within:border-brass/50 transition-colors">
            <textarea
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isThinking}
              placeholder={
                hasSource
                  ? "Pide otro clip, cambia el estilo, o consulta el estado (ej: 'sácame un momento épico')..."
                  : "Escribe una instrucción o comparte un enlace de YouTube..."
              }
              rows={1}
              className="flex-1 bg-transparent border-0 outline-none resize-none px-2 py-1.5 text-xs sm:text-sm text-ink placeholder:text-muted custom-scrollbar max-h-32"
            />
            <button
              onClick={() => handleSendMessage()}
              disabled={!inputText.trim() || isThinking}
              className="p-2 rounded-input bg-brass text-paper hover:bg-brass/90 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shrink-0"
              title="Enviar mensaje"
            >
              <Send size={15} />
            </button>
          </div>
          <p className="text-[10px] text-center text-muted mt-2">
            El chat organiza tus intenciones y trabajos. El Generador de Clips se encarga del renderizado y seguimiento.
          </p>
        </div>
      </div>
    </div>
  );
}
