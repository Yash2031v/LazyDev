/**
 * LazyDev Client Application
 * Polling and UI synchronization for Milestone 1 foundation.
 */

(function () {
  'use strict';

  const ollamaPill = document.getElementById('ollama-pill');
  const ollamaStatusText = document.getElementById('ollama-status-text');
  const cardOllamaState = document.getElementById('card-ollama-state');
  const cardOllamaDetails = document.getElementById('card-ollama-details');
  const cardModelCount = document.getElementById('card-model-count');
  const cardModelList = document.getElementById('card-model-list');
  const uptimeVal = document.getElementById('uptime-val');
  const runtimeVal = document.getElementById('runtime-val');
  const latencyVal = document.getElementById('latency-val');
  const footerLastSync = document.getElementById('footer-last-sync');
  const refreshBtn = document.getElementById('refresh-btn');
  const ollamaSetupGuide = document.getElementById('ollama-setup-guide');

  function formatUptime(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins < 60) return `${mins}m ${secs}s`;
    const hours = Math.floor(mins / 60);
    return `${hours}h ${mins % 60}m`;
  }

  async function fetchStatus() {
    try {
      const startTime = performance.now();
      const res = await fetch('/api/status', {
        headers: { 'Accept': 'application/json' },
        cache: 'no-store'
      });

      const clientLatency = Math.round(performance.now() - startTime);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      renderStatus(data, clientLatency);
    } catch (err) {
      renderError(err.message);
    }
  }

  async function fetchHealth() {
    try {
      const res = await fetch('/api/health', {
        headers: { 'Accept': 'application/json' },
        cache: 'no-store'
      });
      if (res.ok) {
        const data = await res.json();
        if (uptimeVal && data.uptimeSeconds !== undefined) {
          uptimeVal.textContent = formatUptime(data.uptimeSeconds);
        }
      }
    } catch {
      // Nonfatal health poll failure
    }
  }

  function renderStatus(data, clientLatency) {
    const ollama = data.ollama || {};
    const isConnected = Boolean(ollama.connected);

    // Pill
    if (ollamaPill && ollamaStatusText) {
      if (isConnected) {
        ollamaPill.className = 'ollama-pill status-connected';
        ollamaStatusText.textContent = `Ollama: Connected (${ollama.models ? ollama.models.length : 0})`;
      } else {
        ollamaPill.className = 'ollama-pill status-offline';
        ollamaStatusText.textContent = 'Ollama: Offline';
      }
    }

    // Cards
    if (cardOllamaState) {
      cardOllamaState.textContent = isConnected ? 'Connected' : 'Offline / Standby';
      cardOllamaState.style.color = isConnected ? 'var(--accent-emerald)' : 'var(--status-offline)';
    }

    if (cardOllamaDetails) {
      cardOllamaDetails.textContent = ollama.details || 'No details available.';
    }

    if (cardModelCount) {
      const count = (ollama.models && ollama.models.length) || 0;
      cardModelCount.textContent = `${count} model${count === 1 ? '' : 's'}`;
    }

    if (cardModelList) {
      if (isConnected && ollama.models && ollama.models.length > 0) {
        cardModelList.textContent = `Loaded: ${ollama.models.join(', ')}`;
      } else {
        cardModelList.textContent = 'No local open-weight models loaded. Service offline.';
      }
    }

    // Setup guide visibility
    if (ollamaSetupGuide) {
      ollamaSetupGuide.style.display = isConnected ? 'none' : 'block';
    }

    // Runtime & Telemetry
    if (runtimeVal && data.runtime) {
      runtimeVal.textContent = `${data.runtime.node} (${data.runtime.platform}/${data.runtime.arch})`;
    }

    if (latencyVal) {
      const probeLatency = ollama.latencyMs !== null ? `${ollama.latencyMs}ms (probe)` : '';
      latencyVal.textContent = `${clientLatency}ms (api) ${probeLatency ? '· ' + probeLatency : ''}`;
    }

    if (footerLastSync) {
      const now = new Date();
      footerLastSync.textContent = `Last ping: ${now.toLocaleTimeString()}`;
    }
  }

  function renderError(msg) {
    if (ollamaPill && ollamaStatusText) {
      ollamaPill.className = 'ollama-pill status-offline';
      ollamaStatusText.textContent = 'Server: Unreachable';
    }
    if (cardOllamaState) {
      cardOllamaState.textContent = 'Unreachable';
      cardOllamaState.style.color = 'var(--status-offline)';
    }
    if (cardOllamaDetails) {
      cardOllamaDetails.textContent = `Failed to query local server: ${msg}`;
    }
  }

  // Event handlers
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'Checking...';
      Promise.all([fetchStatus(), fetchHealth()]).finally(() => {
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'Refresh Status';
      });
    });
  }

  // Initial load
  fetchStatus();
  fetchHealth();

  // Background polling every 10 seconds
  setInterval(() => {
    fetchStatus();
    fetchHealth();
  }, 10000);
})();
