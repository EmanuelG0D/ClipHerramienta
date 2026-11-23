import React, { useState, useEffect } from 'react';
import { Sparkles, Check, AlertTriangle, RefreshCw, Key, Server, Cpu, ExternalLink, Shield, LogIn } from 'lucide-react';
import { getApiUrl } from '../config';

export default function AiProviderSelector({ onProviderChanged, savedGeminiKey, onKeySet }) {
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [providersData, setProvidersData] = useState(null);
  const [selectedProvider, setSelectedProvider] = useState('antigravity');
  const [feedback, setFeedback] = useState(null);

  // Local form states
  const [geminiKey, setGeminiKey] = useState(savedGeminiKey || localStorage.getItem('gemini_key') || '');
  const [geminiModel, setGeminiModel] = useState('gemini-3.1-flash-lite');
  const [agyModel, setAgyModel] = useState('gemini-3.8-flash-high');
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434/v1');
  const [ollamaModel, setOllamaModel] = useState('qwen2.5:14b');
  const [lmStudioUrl, setLmStudioUrl] = useState('http://localhost:1234/v1');
  const [lmStudioModel, setLmStudioModel] = useState('local-model');

  const fetchProviders = async () => {
    try {
      setLoading(true);
      const res = await fetch(getApiUrl('/api/ai/providers'));
      if (res.ok) {
        const data = await res.json();
        setProvidersData(data);
        if (data.active_provider) {
          setSelectedProvider(data.active_provider);
        }
        const agy = data.providers?.antigravity;
        if (agy?.current_model) {
          setAgyModel(agy.current_model);
        }
        const oll = data.providers?.ollama?.config;
        if (oll?.base_url) setOllamaUrl(oll.base_url);
        if (oll?.model) setOllamaModel(oll.model);

        const lms = data.providers?.lmstudio?.config;
        if (lms?.base_url) setLmStudioUrl(lms.base_url);
        if (lms?.model) setLmStudioModel(lms.model);
      }
    } catch (e) {
      console.error('Failed to load AI providers:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProviders();
  }, []);

  const handleSelectProvider = async (providerId, extraSettings = {}) => {
    setSelectedProvider(providerId);
    setFeedback(null);
    try {
      const payload = {
        provider: providerId,
        settings: {
          ...(providerId === 'antigravity' ? { model: agyModel } : {}),
          ...(providerId === 'gemini' ? { api_key: geminiKey, model: geminiModel } : {}),
          ...(providerId === 'ollama' ? { base_url: ollamaUrl, model: ollamaModel } : {}),
          ...(providerId === 'lmstudio' ? { base_url: lmStudioUrl, model: lmStudioModel } : {}),
          ...extraSettings,
        },
      };

      const res = await fetch(getApiUrl('/api/ai/provider/select'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const data = await res.json();
        setProvidersData(data);
        if (onProviderChanged) onProviderChanged(providerId);
      }
    } catch (e) {
      console.error('Error switching provider:', e);
    }
  };

  const testConnection = async (providerId) => {
    setTesting(true);
    setFeedback(null);
    try {
      const payload = {
        provider: providerId,
        settings: {
          ...(providerId === 'antigravity' ? { model: agyModel } : {}),
          ...(providerId === 'gemini' ? { api_key: geminiKey, model: geminiModel } : {}),
          ...(providerId === 'ollama' ? { base_url: ollamaUrl, model: ollamaModel } : {}),
          ...(providerId === 'lmstudio' ? { base_url: lmStudioUrl, model: lmStudioModel } : {}),
        },
      };

      const res = await fetch(getApiUrl('/api/ai/test-connection'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (data.ok) {
        setFeedback({ type: 'success', message: data.message || 'Conexión exitosa.' });
        fetchProviders();
      } else {
        setFeedback({ type: 'error', message: data.error || 'Fallo en la prueba de conexión.' });
      }
    } catch (e) {
      setFeedback({ type: 'error', message: `Error de red: ${e.message}` });
    } finally {
      setTesting(false);
    }
  };

  const handleAntigravityLogin = async () => {
    setLoggingIn(true);
    setFeedback(null);
    try {
      const res = await fetch(getApiUrl('/api/ai/antigravity/login'), { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        setFeedback({
          type: 'info',
          message: 'Se ha abierto la ventana oficial de inicio de sesión. Inicia sesión en Google y luego pulsa "Comprobar conexión".',
        });
      } else {
        setFeedback({ type: 'error', message: data.error || 'No se pudo iniciar la autenticación.' });
      }
    } catch (e) {
      setFeedback({ type: 'error', message: `Error: ${e.message}` });
    } finally {
      setLoggingIn(false);
    }
  };

  const handleSaveGeminiKey = (key) => {
    setGeminiKey(key);
    if (onKeySet) onKeySet(key);
    localStorage.setItem('gemini_key', key);
    handleSelectProvider('gemini', { api_key: key });
  };

  const agy = providersData?.providers?.antigravity;
  const isAgyReady = agy?.installed && agy?.acp_supported && agy?.authenticated;

  return (
    <div className="card p-4 sm:p-6 mb-8 animate-fade">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5 border-b border-rule pb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-paper3 rounded-input text-brass">
            <Cpu size={20} />
          </div>
          <div>
            <h2 className="font-display lowercase text-lg text-ink">Proveedor de Inteligencia Artificial</h2>
            <p className="text-xs text-muted">Motor de razonamiento para análisis y selección de momentos virales</p>
          </div>
        </div>
        {loading && <RefreshCw size={14} className="animate-spin text-muted" />}
      </div>

      {/* Selector de proveedores */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-6">
        <button
          onClick={() => handleSelectProvider('antigravity')}
          className={`p-3 rounded-input border text-left transition-all relative ${
            selectedProvider === 'antigravity'
              ? 'border-brass bg-paper3 shadow-sm'
              : 'border-rule hover:border-rule2 bg-paper2'
          }`}
        >
          <div className="flex items-center justify-between mb-1">
            <span className="font-medium text-xs text-ink flex items-center gap-1.5">
              <Sparkles size={13} className="text-brass" /> Antigravity
            </span>
            {isAgyReady && <Check size={12} className="text-ok" />}
          </div>
          <span className="text-[10px] text-brass uppercase font-semibold tracking-wider block">ACP Oficial</span>
          <span className="text-[10px] text-muted block mt-0.5">Sin API Key</span>
        </button>

        <button
          onClick={() => handleSelectProvider('gemini')}
          className={`p-3 rounded-input border text-left transition-all ${
            selectedProvider === 'gemini'
              ? 'border-brass bg-paper3 shadow-sm'
              : 'border-rule hover:border-rule2 bg-paper2'
          }`}
        >
          <div className="flex items-center justify-between mb-1">
            <span className="font-medium text-xs text-ink flex items-center gap-1.5">
              <Key size={13} className="text-brass" /> Gemini API
            </span>
            {geminiKey && <Check size={12} className="text-ok" />}
          </div>
          <span className="text-[10px] text-muted block">Google AI Studio</span>
          <span className="text-[10px] text-muted block mt-0.5">Requiere Key</span>
        </button>

        <button
          onClick={() => handleSelectProvider('ollama')}
          className={`p-3 rounded-input border text-left transition-all ${
            selectedProvider === 'ollama'
              ? 'border-brass bg-paper3 shadow-sm'
              : 'border-rule hover:border-rule2 bg-paper2'
          }`}
        >
          <div className="flex items-center justify-between mb-1">
            <span className="font-medium text-xs text-ink flex items-center gap-1.5">
              <Server size={13} className="text-brass" /> Ollama
            </span>
          </div>
          <span className="text-[10px] text-muted block">Local abierto</span>
          <span className="text-[10px] text-muted block mt-0.5">:11434</span>
        </button>

        <button
          onClick={() => handleSelectProvider('lmstudio')}
          className={`p-3 rounded-input border text-left transition-all ${
            selectedProvider === 'lmstudio'
              ? 'border-brass bg-paper3 shadow-sm'
              : 'border-rule hover:border-rule2 bg-paper2'
          }`}
        >
          <div className="flex items-center justify-between mb-1">
            <span className="font-medium text-xs text-ink flex items-center gap-1.5">
              <Server size={13} className="text-brass" /> LM Studio
            </span>
          </div>
          <span className="text-[10px] text-muted block">OpenAI-comp</span>
          <span className="text-[10px] text-muted block mt-0.5">:1234</span>
        </button>
      </div>

      {/* Contenido según proveedor seleccionado */}

      {/* 1. GOOGLE ANTIGRAVITY ACP */}
      {selectedProvider === 'antigravity' && (
        <div className="space-y-4 rounded-input bg-paper2 p-4 border border-rule">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-rule">
            <div>
              <p className="text-xs font-semibold text-ink uppercase tracking-wide flex items-center gap-2">
                Proveedor: Google Antigravity (ACP)
                {isAgyReady ? (
                  <span className="badge-ok">Conectado</span>
                ) : (
                  <span className="badge-warn">Requiere atención</span>
                )}
              </p>
              <p className="text-xs text-muted mt-0.5">
                Utiliza tu autenticación oficial de Antigravity CLI sin consumir créditos de Gemini API.
              </p>
            </div>
            <button
              onClick={() => testConnection('antigravity')}
              disabled={testing}
              className="btn-quiet py-1.5 px-3 text-xs flex items-center gap-1.5 self-start sm:self-auto"
            >
              <RefreshCw size={12} className={testing ? 'animate-spin' : ''} />
              Comprobar conexión
            </button>
          </div>

          {/* Diagnóstico Antigravity */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="p-3 bg-paper3 rounded-input border border-rule space-y-1.5">
              <div className="flex justify-between items-center">
                <span className="text-muted">CLI Antigravity (agy):</span>
                {agy?.installed ? (
                  <span className="text-ok font-medium flex items-center gap-1">
                    <Check size={12} /> Instalado ({agy.version || 'OK'})
                  </span>
                ) : (
                  <span className="text-warn font-medium flex items-center gap-1">
                    <AlertTriangle size={12} /> No detectado
                  </span>
                )}
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted">Protocolo ACP:</span>
                {agy?.acp_supported ? (
                  <span className="text-ok font-medium flex items-center gap-1">
                    <Check size={12} /> Soportado
                  </span>
                ) : (
                  <span className="text-muted">No verificado</span>
                )}
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted">Autenticación Google:</span>
                {agy?.authenticated ? (
                  <span className="text-ok font-medium flex items-center gap-1">
                    <Check size={12} /> Autenticado
                  </span>
                ) : (
                  <span className="text-warn font-medium flex items-center gap-1">
                    <AlertTriangle size={12} /> No autenticado
                  </span>
                )}
              </div>
            </div>

            <div className="p-3 bg-paper3 rounded-input border border-rule space-y-2">
              <span className="text-muted block">Cuenta / Nivel:</span>
              <p className="font-medium text-ink flex items-center gap-1.5">
                <Shield size={13} className="text-brass" />
                {agy?.tier || 'Cuenta Google vinculada a Antigravity'}
              </p>
              {!agy?.authenticated && (
                <button
                  onClick={handleAntigravityLogin}
                  disabled={loggingIn}
                  className="btn-primary py-1.5 px-3 text-xs flex items-center gap-1.5 w-full justify-center mt-2"
                >
                  <LogIn size={13} />
                  {loggingIn ? 'Abriendo terminal...' : 'Iniciar sesión con Google'}
                </button>
              )}
            </div>
          </div>

          {/* Selector de Modelo ACP */}
          <div className="pt-2">
            <label className="block text-xs font-medium text-ink mb-1.5">Modelo / Agente ACP:</label>
            <select
              value={agyModel}
              onChange={(e) => {
                setAgyModel(e.target.value);
                handleSelectProvider('antigravity', { model: e.target.value });
              }}
              className="input-field text-xs"
            >
              {agy?.available_models && agy.available_models.length > 0 ? (
                agy.available_models.map((m) => (
                  <option key={m.modelId} value={m.modelId}>
                    {m.name || m.modelId}
                  </option>
                ))
              ) : (
                <>
                  <option value="gemini-3.8-flash-high">Gemini 3.8 Flash (High) - Recomendado</option>
                  <option value="gemini-3.8-flash-medium">Gemini 3.8 Flash (Medium)</option>
                  <option value="gemini-3.8-flash-low">Gemini 3.8 Flash (Low)</option>
                  <option value="claude-sonnet-4-6">Claude Sonnet 4.6 (Thinking)</option>
                  <option value="claude-opus-4-6-thinking">Claude Opus 4.6 (Thinking)</option>
                  <option value="gpt-oss-120b-medium">GPT-OSS 120B (Medium)</option>
                </>
              )}
            </select>
          </div>
        </div>
      )}

      {/* 2. GEMINI API */}
      {selectedProvider === 'gemini' && (
        <div className="space-y-4 rounded-input bg-paper2 p-4 border border-rule">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-rule">
            <div>
              <p className="text-xs font-semibold text-ink uppercase tracking-wide flex items-center gap-2">
                Proveedor: Google Gemini API
                {geminiKey ? <span className="badge-ok">Configurado</span> : <span className="badge-warn">Falta Key</span>}
              </p>
              <p className="text-xs text-muted mt-0.5">Clave de API de Google AI Studio para procesamiento directo en la nube.</p>
            </div>
            <button
              onClick={() => testConnection('gemini')}
              disabled={testing || !geminiKey}
              className="btn-quiet py-1.5 px-3 text-xs flex items-center gap-1.5 self-start sm:self-auto"
            >
              <RefreshCw size={12} className={testing ? 'animate-spin' : ''} />
              Comprobar API Key
            </button>
          </div>

          <div>
            <label className="block text-xs font-medium text-ink mb-1">Gemini API Key:</label>
            <div className="flex gap-2">
              <input
                type="password"
                value={geminiKey}
                onChange={(e) => setGeminiKey(e.target.value)}
                placeholder="AIzaSy..."
                className="input-field text-xs font-mono flex-1"
              />
              <button
                onClick={() => handleSaveGeminiKey(geminiKey)}
                className="btn-primary py-1.5 px-3 text-xs"
              >
                Guardar
              </button>
            </div>
            <p className="text-[11px] text-muted mt-1.5">
              Consigue tu clave gratuita en{' '}
              <a
                href="https://aistudio.google.com/app/apikey"
                target="_blank"
                rel="noopener noreferrer"
                className="text-brass hover:underline inline-flex items-center gap-1"
              >
                aistudio.google.com/app/apikey <ExternalLink size={10} />
              </a>
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-ink mb-1">Modelo:</label>
            <select
              value={geminiModel}
              onChange={(e) => {
                setGeminiModel(e.target.value);
                handleSelectProvider('gemini', { model: e.target.value });
              }}
              className="input-field text-xs"
            >
              <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite (Rápido y económico)</option>
              <option value="gemini-2.5-flash">gemini-2.5-flash</option>
              <option value="gemini-2.5-pro">gemini-2.5-pro</option>
            </select>
          </div>
        </div>
      )}

      {/* 3. OLLAMA */}
      {selectedProvider === 'ollama' && (
        <div className="space-y-4 rounded-input bg-paper2 p-4 border border-rule">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-rule">
            <div>
              <p className="text-xs font-semibold text-ink uppercase tracking-wide flex items-center gap-2">
                Proveedor: Ollama (Local)
              </p>
              <p className="text-xs text-muted mt-0.5">Servidor local compatible con OpenAI en tu máquina o red local.</p>
            </div>
            <button
              onClick={() => testConnection('ollama')}
              disabled={testing}
              className="btn-quiet py-1.5 px-3 text-xs flex items-center gap-1.5 self-start sm:self-auto"
            >
              <RefreshCw size={12} className={testing ? 'animate-spin' : ''} />
              Comprobar conexión
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink mb-1">Endpoint Base URL:</label>
              <input
                type="text"
                value={ollamaUrl}
                onChange={(e) => setOllamaUrl(e.target.value)}
                placeholder="http://localhost:11434/v1"
                className="input-field text-xs font-mono"
              />
              <span className="text-[10px] text-muted mt-1 block">O http://host.docker.internal:11434/v1 si usas Docker</span>
            </div>
            <div>
              <label className="block text-xs font-medium text-ink mb-1">Modelo Ollama:</label>
              <input
                type="text"
                value={ollamaModel}
                onChange={(e) => setOllamaModel(e.target.value)}
                placeholder="qwen2.5:14b"
                className="input-field text-xs font-mono"
              />
              <span className="text-[10px] text-muted mt-1 block">Ejemplo: qwen2.5:14b, llama3.1:8b</span>
            </div>
          </div>
          <button
            onClick={() => handleSelectProvider('ollama', { base_url: ollamaUrl, model: ollamaModel })}
            className="btn-primary py-1.5 px-3 text-xs"
          >
            Aplicar configuración Ollama
          </button>
        </div>
      )}

      {/* 4. LM STUDIO */}
      {selectedProvider === 'lmstudio' && (
        <div className="space-y-4 rounded-input bg-paper2 p-4 border border-rule">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-rule">
            <div>
              <p className="text-xs font-semibold text-ink uppercase tracking-wide flex items-center gap-2">
                Proveedor: LM Studio (Local)
              </p>
              <p className="text-xs text-muted mt-0.5">Servidor local de inferencia de modelos en LM Studio.</p>
            </div>
            <button
              onClick={() => testConnection('lmstudio')}
              disabled={testing}
              className="btn-quiet py-1.5 px-3 text-xs flex items-center gap-1.5 self-start sm:self-auto"
            >
              <RefreshCw size={12} className={testing ? 'animate-spin' : ''} />
              Comprobar conexión
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink mb-1">Endpoint Base URL:</label>
              <input
                type="text"
                value={lmStudioUrl}
                onChange={(e) => setLmStudioUrl(e.target.value)}
                placeholder="http://localhost:1234/v1"
                className="input-field text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink mb-1">Identificador de modelo:</label>
              <input
                type="text"
                value={lmStudioModel}
                onChange={(e) => setLmStudioModel(e.target.value)}
                placeholder="local-model"
                className="input-field text-xs font-mono"
              />
            </div>
          </div>
          <button
            onClick={() => handleSelectProvider('lmstudio', { base_url: lmStudioUrl, model: lmStudioModel })}
            className="btn-primary py-1.5 px-3 text-xs"
          >
            Aplicar configuración LM Studio
          </button>
        </div>
      )}

      {/* Feedback banner */}
      {feedback && (
        <div
          className={`p-3 rounded-input text-xs flex items-start gap-2 mt-4 animate-fade ${
            feedback.type === 'success'
              ? 'bg-ok/10 text-ok border border-ok/30'
              : feedback.type === 'info'
              ? 'bg-paper3 text-ink2 border border-rule'
              : 'bg-warn/10 text-warn border border-warn/30'
          }`}
        >
          {feedback.type === 'success' ? (
            <Check size={14} className="shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          )}
          <span>{feedback.message}</span>
        </div>
      )}
    </div>
  );
}
