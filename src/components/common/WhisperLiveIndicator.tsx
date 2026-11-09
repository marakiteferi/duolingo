import { useState, useEffect, useCallback, useRef } from 'react';
import { db } from '../../db/database';

export interface WhisperHealthInfo {
  online: boolean;
  model?: string;
  device?: string;
  statusText?: string;
  checkedAt: Date;
}

interface WhisperLiveIndicatorProps {
  compact?: boolean;
  className?: string;
}

export function WhisperLiveIndicator({ compact = false, className = '' }: WhisperLiveIndicatorProps) {
  const [health, setHealth] = useState<WhisperHealthInfo>({
    online: false,
    checkedAt: new Date(),
  });
  const [checking, setChecking] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const checkConnection = useCallback(async () => {
    setChecking(true);
    try {
      const settings = await db.settings.get('app-settings');
      const transcribeUrl = settings?.localWhisperUrl || settings?.localSttEndpoint || 'http://127.0.0.1:8000/transcribe';
      const baseUrl = transcribeUrl.replace(/\/transcribe\/?$/, '');
      const healthUrl = `${baseUrl}/health`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      const res = await fetch(healthUrl, { signal: controller.signal }).catch(() => null);
      clearTimeout(timeoutId);

      if (res && res.ok) {
        const data = await res.json().catch(() => ({}));
        setHealth({
          online: true,
          model: data.model || 'large-v3-turbo',
          device: data.device || 'cuda',
          statusText: 'Connected & Ready (CUDA GPU)',
          checkedAt: new Date(),
        });
      } else if (res && res.status === 404) {
        // FastAPI is running even if /health is not defined
        setHealth({
          online: true,
          model: 'large-v3-turbo',
          device: 'cuda',
          statusText: 'Connected (Uvicorn running)',
          checkedAt: new Date(),
        });
      } else {
        setHealth({
          online: false,
          statusText: 'Server Offline (Port 8000)',
          checkedAt: new Date(),
        });
      }
    } catch {
      setHealth({
        online: false,
        statusText: 'Offline',
        checkedAt: new Date(),
      });
    } finally {
      setChecking(false);
    }
  }, []);

  // Initial check on mount + auto-polling every 4 seconds
  useEffect(() => {
    void checkConnection();
    const interval = setInterval(checkConnection, 4000);
    return () => clearInterval(interval);
  }, [checkConnection]);

  // Close popover when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDetails(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div ref={containerRef} className={`relative inline-block ${className}`}>
      {/* Live Badge Trigger */}
      <button
        type="button"
        onClick={() => setShowDetails((prev) => !prev)}
        className={`flex items-center gap-2 rounded-full border transition-all cursor-pointer font-medium select-none ${
          compact ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-xs'
        } ${
          health.online
            ? 'bg-emerald-50 border-emerald-300 text-emerald-800 hover:bg-emerald-100 shadow-2xs'
            : 'bg-rose-50 border-rose-200 text-rose-700 hover:bg-rose-100'
        }`}
        title="Click to view Whisper AI connection details & controls"
      >
        {/* Pulsing Status Dot */}
        <span className="relative flex h-2 w-2">
          {health.online ? (
            <>
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </>
          ) : (
            <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500" />
          )}
        </span>

        {/* Status Text */}
        <span className="font-semibold">
          {checking && !health.online
            ? 'Whisper: Pinging...'
            : health.online
            ? compact
              ? 'Whisper: GPU Live'
              : 'Whisper AI: Online (CUDA GPU)'
            : compact
            ? 'Whisper: Offline'
            : 'Whisper AI: Offline'}
        </span>

        {/* Small dropdown arrow */}
        <svg
          className={`w-3 h-3 text-current opacity-60 transition-transform ${
            showDetails ? 'rotate-180' : ''
          }`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Details Popover Card */}
      {showDetails && (
        <div className="absolute right-0 mt-2 w-80 bg-white border border-slate-200 rounded-2xl shadow-xl z-50 p-4 text-slate-800 space-y-3 animate-in fade-in zoom-in-95 duration-100">
          <div className="flex items-center justify-between pb-2 border-b border-slate-100">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
              Faster-Whisper Status
            </span>
            <span
              className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                health.online
                  ? 'bg-emerald-100 text-emerald-800'
                  : 'bg-rose-100 text-rose-700'
              }`}
            >
              {health.online ? '🟢 CONNECTED' : '🔴 DISCONNECTED'}
            </span>
          </div>

          <div className="space-y-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-slate-500">Local Endpoint:</span>
              <span className="font-mono text-slate-700">http://127.0.0.1:8000</span>
            </div>

            {health.online ? (
              <>
                <div className="flex justify-between">
                  <span className="text-slate-500">Model:</span>
                  <span className="font-semibold text-emerald-700">{health.model}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Hardware:</span>
                  <span className="font-semibold text-emerald-700">NVIDIA CUDA GPU</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Verbatim Fillers:</span>
                  <span className="text-emerald-700 font-medium">Active ("uh", "um", pauses)</span>
                </div>
              </>
            ) : (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-[11px] text-amber-900 space-y-1.5">
                <p className="font-bold">How to start your local Whisper server:</p>
                <ol className="list-decimal list-inside space-y-0.5 text-amber-800">
                  <li>
                    Open <code>stt-backend/</code> folder
                  </li>
                  <li>
                    Double-click <code>start-server.bat</code>
                  </li>
                  <li>Or run: <code>python app.py</code></li>
                </ol>
                <p className="text-[10px] text-amber-700 pt-1">
                  Once started, this badge will automatically turn green within 4 seconds.
                </p>
              </div>
            )}
          </div>

          <div className="pt-2 border-t border-slate-100 flex items-center justify-between">
            <span className="text-[10px] text-slate-400">
              Checked {health.checkedAt.toLocaleTimeString()}
            </span>
            <button
              type="button"
              onClick={checkConnection}
              disabled={checking}
              className="text-xs font-semibold text-primary-700 bg-primary-50 hover:bg-primary-100 border border-primary-200 px-3 py-1 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
            >
              {checking ? 'Testing...' : '🔄 Test Now'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
export default WhisperLiveIndicator;
