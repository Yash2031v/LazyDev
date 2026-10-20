/**
 * LazyDev Client Application
 * Polling, project indexing, and read-only tools synchronization.
 */

(function () {
  'use strict';

  // System Elements
  const ollamaPill = document.getElementById('ollama-pill');
  const ollamaStatusText = document.getElementById('ollama-status-text');
  const cardOllamaState = document.getElementById('card-ollama-state');
  const cardOllamaDetails = document.getElementById('card-ollama-details');
  const uptimeVal = document.getElementById('uptime-val');
  const runtimeVal = document.getElementById('runtime-val');
  const activeProjectVal = document.getElementById('active-project-val');
  const footerLastSync = document.getElementById('footer-last-sync');
  const refreshBtn = document.getElementById('refresh-btn');

  // Project Elements
  const projectPathInput = document.getElementById('project-path-input');
  const scanProjectBtn = document.getElementById('scan-project-btn');
  const projectStatusBadge = document.getElementById('project-status-badge');
  const cardTotalFiles = document.getElementById('card-total-files');
  const cardTotalSize = document.getElementById('card-total-size');
  const cardSkippedCount = document.getElementById('card-skipped-count');
  const cardFileTypes = document.getElementById('card-file-types');
  const cardFileTypesDesc = document.getElementById('card-file-types-desc');
  const fileListContainer = document.getElementById('file-list-container');
  const searchInput = document.getElementById('search-input');
  const searchBtn = document.getElementById('search-btn');
  const searchResults = document.getElementById('search-results');
  const searchResultsHeader = document.getElementById('search-results-header');
  const searchList = document.getElementById('search-list');

  // Modal Elements
  const fileModal = document.getElementById('file-modal');
  const modalFileTitle = document.getElementById('modal-file-title');
  const modalFileContent = document.getElementById('modal-file-content');
  const modalCloseBtn = document.getElementById('modal-close-btn');

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const kb = (bytes / 1024).toFixed(1);
    if (kb < 1024) return `${kb} KB`;
    const mb = (bytes / (1024 * 1024)).toFixed(1);
    return `${mb} MB`;
  }

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
      const res = await fetch('/api/status', {
        headers: { 'Accept': 'application/json' },
        cache: 'no-store'
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      renderStatus(data);
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

  function renderStatus(data) {
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

    // Status Cards
    if (cardOllamaState) {
      cardOllamaState.textContent = isConnected ? 'Connected' : 'Offline / Standby';
      cardOllamaState.style.color = isConnected ? 'var(--accent-emerald)' : 'var(--status-offline)';
    }

    if (cardOllamaDetails) {
      cardOllamaDetails.textContent = ollama.details || 'No details available.';
    }

    // Telemetry
    if (runtimeVal && data.runtime) {
      runtimeVal.textContent = `${data.runtime.node} (${data.runtime.platform}/${data.runtime.arch})`;
    }

    if (activeProjectVal && data.project) {
      if (data.project.hasActiveProject && data.project.root) {
        activeProjectVal.textContent = data.project.root;
        activeProjectVal.title = data.project.root;
      } else {
        activeProjectVal.textContent = 'None';
      }
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

  // --- Project Workspace & Indexing Logic ---

  async function checkActiveProject() {
    try {
      const res = await fetch('/api/project/root', { headers: { 'Accept': 'application/json' } });
      if (!res.ok) return;

      const data = await res.json();
      if (data.hasActiveProject && data.root) {
        if (projectPathInput) projectPathInput.value = data.root;
        await refreshProjectData();
      }
    } catch {
      // Nonfatal
    }
  }

  async function setProjectRoot(targetPath) {
    if (!targetPath || !targetPath.trim()) return;

    scanProjectBtn.disabled = true;
    scanProjectBtn.textContent = 'Scanning...';

    try {
      const res = await fetch('/api/project/root', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ path: targetPath.trim() })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || data.message || 'Failed to scan project root');
      }

      await refreshProjectData();
    } catch (err) {
      alert(`Error indexing project: ${err.message}`);
    } finally {
      scanProjectBtn.disabled = false;
      scanProjectBtn.textContent = 'Index Project';
    }
  }

  async function refreshProjectData() {
    try {
      const [summaryRes, filesRes] = await Promise.all([
        fetch('/api/project/summary', { headers: { 'Accept': 'application/json' } }),
        fetch('/api/project/files', { headers: { 'Accept': 'application/json' } })
      ]);

      if (summaryRes.ok && filesRes.ok) {
        const summary = await summaryRes.json();
        const filesData = await filesRes.json();
        renderProjectData(summary, filesData);
      }
    } catch {
      // Nonfatal
    }
  }

  function renderProjectData(summary, filesData) {
    if (projectStatusBadge) {
      projectStatusBadge.textContent = 'Active Project';
    }

    if (cardTotalFiles) {
      cardTotalFiles.textContent = summary.totalFiles || 0;
    }

    if (cardTotalSize) {
      cardTotalSize.textContent = formatBytes(summary.totalSizeBytes || 0);
    }

    if (cardSkippedCount) {
      cardSkippedCount.textContent = summary.skippedCount || 0;
    }

    if (cardFileTypes && summary.fileTypes) {
      const topExts = Object.keys(summary.fileTypes).slice(0, 3).join(', ');
      cardFileTypes.textContent = topExts || 'None';
    }

    if (cardFileTypesDesc && summary.fileTypes) {
      const count = Object.keys(summary.fileTypes).length;
      cardFileTypesDesc.textContent = `${count} distinct file extensions`;
    }

    if (fileListContainer && filesData.files) {
      if (filesData.files.length === 0) {
        fileListContainer.innerHTML = '<p class="empty-state">No readable text files indexed in this project.</p>';
        return;
      }

      fileListContainer.innerHTML = '';
      for (const file of filesData.files) {
        const item = document.createElement('div');
        item.className = 'file-item';
        item.innerHTML = `
          <span>${file.relativePath}</span>
          <span class="file-size">${formatBytes(file.sizeBytes)}</span>
        `;
        item.addEventListener('click', () => viewFile(file.relativePath));
        fileListContainer.appendChild(item);
      }
    }
  }

  async function viewFile(relativePath) {
    try {
      const res = await fetch(`/api/project/file?path=${encodeURIComponent(relativePath)}`, {
        headers: { 'Accept': 'application/json' }
      });

      if (!res.ok) {
        const err = await res.json();
        alert(err.error?.message || 'Access denied');
        return;
      }

      const fileData = await res.json();
      if (modalFileTitle) modalFileTitle.textContent = `${fileData.relativePath} (${formatBytes(fileData.sizeBytes)})`;
      if (modalFileContent) modalFileContent.textContent = fileData.content;
      if (fileModal) fileModal.style.display = 'flex';
    } catch (err) {
      alert(`Error reading file: ${err.message}`);
    }
  }

  async function performSearch(query) {
    if (!query || !query.trim()) return;

    searchBtn.disabled = true;
    searchBtn.textContent = '...';

    try {
      const res = await fetch('/api/project/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ query: query.trim() })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || 'Search failed');
      }

      renderSearchResults(data);
    } catch (err) {
      alert(`Search error: ${err.message}`);
    } finally {
      searchBtn.disabled = false;
      searchBtn.textContent = 'Search';
    }
  }

  function renderSearchResults(data) {
    if (!searchResults || !searchList) return;

    searchResults.style.display = 'block';
    searchResultsHeader.textContent = `Found ${data.totalMatches} match${data.totalMatches === 1 ? '' : 'es'} for "${data.query}"`;
    searchList.innerHTML = '';

    if (data.matches.length === 0) {
      searchList.innerHTML = '<li class="search-match-item">No matches found.</li>';
      return;
    }

    for (const match of data.matches) {
      const li = document.createElement('li');
      li.className = 'search-match-item';
      li.innerHTML = `
        <span class="search-match-loc">${match.relativePath}:${match.lineNumber}</span>
        <span>${escapeHtml(match.lineContent)}</span>
      `;
      li.style.cursor = 'pointer';
      li.addEventListener('click', () => viewFile(match.relativePath));
      searchList.appendChild(li);
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Event Listeners
  if (scanProjectBtn && projectPathInput) {
    scanProjectBtn.addEventListener('click', () => {
      setProjectRoot(projectPathInput.value);
    });

    projectPathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        setProjectRoot(projectPathInput.value);
      }
    });
  }

  if (searchBtn && searchInput) {
    searchBtn.addEventListener('click', () => {
      performSearch(searchInput.value);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        performSearch(searchInput.value);
      }
    });
  }

  if (modalCloseBtn && fileModal) {
    modalCloseBtn.addEventListener('click', () => {
      fileModal.style.display = 'none';
    });

    fileModal.addEventListener('click', (e) => {
      if (e.target === fileModal) {
        fileModal.style.display = 'none';
      }
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'Checking...';
      Promise.all([fetchStatus(), fetchHealth(), refreshProjectData()]).finally(() => {
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'Refresh Status';
      });
    });
  }

  // Initial load
  fetchStatus();
  fetchHealth();
  checkActiveProject();

  // Background polling every 10 seconds
  setInterval(() => {
    fetchStatus();
    fetchHealth();
  }, 10000);
})();
