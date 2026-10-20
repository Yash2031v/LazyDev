/**
 * LazyDev Client Application
 * Polling, project indexing, and read-only tools synchronization.
 */

(function () {
  'use strict';

  // Demo Session Isolation
  let demoSessionId = 'session_' + Math.random().toString(36).substring(2, 10);
  try {
    const saved = sessionStorage.getItem('lazydev_demo_session');
    if (saved) {
      demoSessionId = saved;
    } else {
      sessionStorage.setItem('lazydev_demo_session', demoSessionId);
    }
  } catch {}

  const originalFetch = window.fetch;
  window.fetch = function (resource, init) {
    if (typeof resource === 'string' && resource.startsWith('/api/')) {
      init = init || {};
      const headers = new Headers(init.headers || {});
      if (!headers.has('x-demo-session')) {
        headers.set('x-demo-session', demoSessionId);
      }
      init.headers = headers;
    }
    return originalFetch.call(this, resource, init);
  };

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

  // Milestone 3 Proposal Elements
  const proposalPathInput = document.getElementById('proposal-path-input');
  const proposalContentInput = document.getElementById('proposal-content-input');
  const createProposalBtn = document.getElementById('create-proposal-btn');
  const proposalsListContainer = document.getElementById('proposals-list-container');

  const proposalModal = document.getElementById('proposal-modal');
  const proposalModalCloseBtn = document.getElementById('proposal-modal-close-btn');
  const proposalModalFileTitle = document.getElementById('proposal-modal-file-title');
  const proposalModalStatusBadge = document.getElementById('proposal-modal-status-badge');
  const proposalModalAdds = document.getElementById('proposal-modal-adds');
  const proposalModalDels = document.getElementById('proposal-modal-dels');
  const proposalModalIdTag = document.getElementById('proposal-modal-id-tag');
  const proposalAlertBanner = document.getElementById('proposal-alert-banner');
  const proposalDiffCode = document.getElementById('proposal-diff-code');
  const proposalSafetyText = document.getElementById('proposal-safety-text');
  const proposalRejectBtn = document.getElementById('proposal-reject-btn');
  const proposalApproveBtn = document.getElementById('proposal-approve-btn');
  const proposalApplyBtn = document.getElementById('proposal-apply-btn');

  // Milestone 4: AI Assistant Elements
  const aiModelSelect = document.getElementById('ai-model-select');
  const aiTargetFile = document.getElementById('ai-target-file');
  const aiPromptInput = document.getElementById('ai-prompt-input');
  const aiGenerateBtn = document.getElementById('ai-generate-btn');
  const aiCancelBtn = document.getElementById('ai-cancel-btn');
  const aiStatusContainer = document.getElementById('ai-status-container');
  const aiStatusMessage = document.getElementById('ai-status-message');

  let activeAiTaskId = null;
  let currentProposal = null;
  let currentAiMode = 'ollama';
  const proposalTokens = new Map(); // proposalId -> approvalToken

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
    const isPublicDemo = data.isPublicDemo || data.app?.isPublicDemo || data.app?.environment === 'public-demo';
    const isDemo = isPublicDemo || data.aiMode === 'demo' || data.app?.aiMode === 'demo';
    currentAiMode = isDemo ? 'demo' : 'ollama';

    const publicDemoBanner = document.getElementById('public-demo-banner');
    if (publicDemoBanner) {
      publicDemoBanner.style.display = isPublicDemo ? 'flex' : 'none';
    }

    const serverBadge = document.getElementById('server-badge');
    if (serverBadge) {
      serverBadge.textContent = isPublicDemo ? 'Demo: In-Memory Sandbox' : 'Host: 127.0.0.1';
    }

    const aiDemoBanner = document.getElementById('ai-demo-banner');
    if (aiDemoBanner) {
      aiDemoBanner.style.display = isDemo ? 'flex' : 'none';
    }

    const ollama = data.ollama || {};
    const isConnected = Boolean(ollama.connected);

    // Pill
    if (ollamaPill && ollamaStatusText) {
      if (isPublicDemo) {
        ollamaPill.className = 'ollama-pill status-demo';
        ollamaStatusText.textContent = 'Demo Mode — Safe In-Memory';
      } else if (isDemo) {
        ollamaPill.className = 'ollama-pill status-demo';
        ollamaStatusText.textContent = 'Demo Mode — no AI model connected.';
      } else if (isConnected) {
        ollamaPill.className = 'ollama-pill status-connected';
        ollamaStatusText.textContent = `Ollama: Connected (${ollama.models ? ollama.models.length : 0})`;
      } else {
        ollamaPill.className = 'ollama-pill status-offline';
        ollamaStatusText.textContent = 'Ollama: Offline';
      }
    }

    loadAiModels(ollama.models || [], isDemo);

    // Status Cards
    if (cardOllamaState) {
      if (isPublicDemo) {
        cardOllamaState.textContent = 'Public Demo';
        cardOllamaState.style.color = '#58a6ff';
      } else if (isDemo) {
        cardOllamaState.textContent = 'Demo Mode';
        cardOllamaState.style.color = '#f59e0b';
      } else {
        cardOllamaState.textContent = isConnected ? 'Connected' : 'Offline / Standby';
        cardOllamaState.style.color = isConnected ? 'var(--accent-emerald)' : 'var(--status-offline)';
      }
    }

    if (cardOllamaDetails) {
      if (isPublicDemo) {
        cardOllamaDetails.textContent = 'Public demo mode active on Render. In-memory virtual workspace with sample proposals.';
      } else if (isDemo) {
        cardOllamaDetails.textContent = 'Demo Mode active — no AI model connected. Deterministic sample proposals enabled.';
      } else {
        cardOllamaDetails.textContent = ollama.details || 'No details available.';
      }
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

    if (isPublicDemo) {
      if (projectPathInput) {
        projectPathInput.value = 'demo-sandbox (Virtual Sandbox)';
        projectPathInput.disabled = true;
      }
      if (scanProjectBtn) {
        scanProjectBtn.disabled = true;
        scanProjectBtn.textContent = 'Demo Active';
      }
      if (aiTargetFile && !aiTargetFile.value) {
        aiTargetFile.value = 'src/calculator.ts';
      }
      if (aiPromptInput && !aiPromptInput.value) {
        aiPromptInput.value = 'Add power and clamp helper functions';
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
        if (projectPathInput && !projectPathInput.disabled) {
          projectPathInput.value = data.root;
        }
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
        item.addEventListener('click', () => {
          viewFile(file.relativePath);
          if (aiTargetFile) {
            aiTargetFile.value = file.relativePath;
          }
        });
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

  // Milestone 3: Proposal Management & Diff Logic
  async function loadProposals() {
    if (!proposalsListContainer) return;
    try {
      const res = await fetch('/api/project/proposals', {
        headers: { 'Accept': 'application/json' }
      });
      if (!res.ok) return;
      const data = await res.json();
      renderProposalsList(data.proposals || []);
    } catch {
      // Nonfatal
    }
  }

  function renderProposalsList(proposals) {
    if (!proposalsListContainer) return;
    if (proposals.length === 0) {
      proposalsListContainer.innerHTML = '<p class="empty-state">No proposals created yet.</p>';
      return;
    }

    proposalsListContainer.innerHTML = '';
    for (const p of proposals) {
      const card = document.createElement('div');
      card.className = 'proposal-card';
      const statusClass = `badge-status-${p.status}`;
      const statusLabel = p.status.replace(/_/g, ' ').toUpperCase();

      card.innerHTML = `
        <div class="proposal-card-info">
          <span class="proposal-card-path">${escapeHtml(p.relativePath)}</span>
          <div class="proposal-card-meta">
            <span class="diff-stat-add">+${p.additions}</span>
            <span class="diff-stat-del">-${p.deletions}</span>
            <span>Created ${new Date(p.createdAt).toLocaleTimeString()}</span>
            ${p.statusReason ? `<span>• ${escapeHtml(p.statusReason)}</span>` : ''}
          </div>
        </div>
        <div style="display: flex; gap: 8px; align-items: center;">
          <span class="badge ${statusClass}">${statusLabel}</span>
          <button class="btn btn-secondary" data-proposal-id="${p.id}">Inspect Diff</button>
        </div>
      `;

      card.querySelector('button').addEventListener('click', () => {
        openProposalModal(p.id);
      });

      proposalsListContainer.appendChild(card);
    }
  }

  // --- Milestone 4: AI Task Assistant Logic ---

  async function loadAiModels(modelsFromStatus, isDemoMode) {
    if (!aiModelSelect) return;
    try {
      let models = modelsFromStatus;
      let isDemo = Boolean(isDemoMode || currentAiMode === 'demo');
      if (!models || models.length === 0) {
        const res = await fetch('/api/ai/models', { headers: { 'Accept': 'application/json' } });
        if (res.ok) {
          const data = await res.json();
          models = data.models || [];
          if (data.mode === 'demo') isDemo = true;
        }
      }

      if (isDemo) {
        currentAiMode = 'demo';
        const demoBanner = document.getElementById('ai-demo-banner');
        if (demoBanner) demoBanner.style.display = 'flex';
        if (aiGenerateBtn) aiGenerateBtn.textContent = 'Generate Sample Proposal (Demo Mode)';
      } else {
        if (aiGenerateBtn) aiGenerateBtn.textContent = 'Generate Proposal with AI';
      }

      if (!models || models.length === 0) {
        aiModelSelect.innerHTML = '<option value="">No models available (check Ollama)</option>';
        aiModelSelect.disabled = true;
        if (aiGenerateBtn) aiGenerateBtn.disabled = true;
        return;
      }

      const previousValue = aiModelSelect.value;
      aiModelSelect.innerHTML = '';
      aiModelSelect.disabled = false;
      if (aiGenerateBtn) aiGenerateBtn.disabled = false;

      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = isDemo ? `${m} [Deterministic Sample]` : m;
        aiModelSelect.appendChild(opt);
      }

      if (previousValue && models.includes(previousValue)) {
        aiModelSelect.value = previousValue;
      }
    } catch {
      // Nonfatal model load failure
    }
  }

  async function startAiTask() {
    if (!aiModelSelect || !aiTargetFile || !aiPromptInput) return;

    const model = aiModelSelect.value;
    const targetFilePath = aiTargetFile.value.trim();
    const taskPrompt = aiPromptInput.value.trim();

    if (!model) {
      alert('Please select an Ollama model.');
      return;
    }
    if (!targetFilePath) {
      alert('Please specify a target file path (or click a file in the Permitted Files list).');
      return;
    }
    if (!taskPrompt) {
      alert('Please enter task instructions.');
      return;
    }

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    activeAiTaskId = taskId;

    aiGenerateBtn.disabled = true;
    aiCancelBtn.style.display = 'inline-block';
    aiStatusContainer.style.display = 'flex';
    aiStatusMessage.textContent = currentAiMode === 'demo'
      ? 'Generating sample edit proposal (Demo Mode — no AI)...'
      : `Querying local model "${model}"... (Isolated cancellation enabled)`;

    try {
      const res = await fetch('/api/ai/task', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ model, targetFilePath, taskPrompt, taskId })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error?.message || data.message || 'AI task failed.');
      }

      aiStatusMessage.textContent = currentAiMode === 'demo'
        ? '✓ Sample edit proposal generated and staged!'
        : '✓ AI edit proposal generated and staged!';
      aiPromptInput.value = '';

      // Reload proposals list and auto-open diff inspection modal
      await loadProposals();
      if (data.result?.proposal?.id) {
        if (data.result.proposal.approvalToken) {
          proposalTokens.set(data.result.proposal.id, data.result.proposal.approvalToken);
        }
        await openProposalModal(data.result.proposal.id, data.result.proposal);
      }
    } catch (err) {
      alert(`AI Task Error: ${err.message}`);
    } finally {
      activeAiTaskId = null;
      aiGenerateBtn.disabled = false;
      aiCancelBtn.style.display = 'none';
      setTimeout(() => {
        aiStatusContainer.style.display = 'none';
      }, 4000);
    }
  }

  async function cancelAiTask() {
    if (!activeAiTaskId) return;
    aiStatusMessage.textContent = 'Cancelling task...';
    try {
      await fetch('/api/ai/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ taskId: activeAiTaskId })
      });
    } catch {
      // Nonfatal cancel failure
    }
  }

  async function createProposalAction() {
    if (!proposalPathInput || !proposalContentInput) return;
    const relativePath = proposalPathInput.value.trim();
    const newContent = proposalContentInput.value;

    if (!relativePath) {
      alert('Please enter a target relative path.');
      return;
    }

    createProposalBtn.disabled = true;
    createProposalBtn.textContent = 'Generating Diff...';

    try {
      const res = await fetch('/api/project/proposals', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ relativePath, newContent })
      });

      const data = await res.json();
      if (!res.ok || !data.proposal) {
        throw new Error(data.error?.message || data.message || 'Failed to create proposal.');
      }

      // Cache token for this proposal session
      if (data.proposal?.id && data.proposal?.approvalToken) {
        proposalTokens.set(data.proposal.id, data.proposal.approvalToken);
      }

      proposalPathInput.value = '';
      proposalContentInput.value = '';
      await loadProposals();
      await openProposalModal(data.proposal.id, data.proposal);
    } catch (err) {
      alert(`Proposal Error: ${err.message}`);
    } finally {
      createProposalBtn.disabled = false;
      createProposalBtn.textContent = 'Generate Diff Preview';
    }
  }

  async function openProposalModal(proposalId, preloadedProposal) {
    if (!proposalModal) return;
    if (!proposalId && !preloadedProposal) {
      alert('Cannot open proposal: No valid proposal selected.');
      return;
    }

    try {
      if (preloadedProposal && preloadedProposal.diff) {
        currentProposal = preloadedProposal;
      } else {
        const res = await fetch(`/api/project/proposals/${encodeURIComponent(proposalId)}`, {
          headers: { 'Accept': 'application/json' }
        });
        const data = await res.json();
        if (!res.ok || !data.proposal) {
          throw new Error(data.error?.message || data.message || 'Failed to load proposal details.');
        }
        currentProposal = data.proposal;
      }

      if (currentProposal.approvalToken) {
        proposalTokens.set(currentProposal.id, currentProposal.approvalToken);
      }

      renderProposalModal(currentProposal);
      proposalModal.style.display = 'flex';
    } catch (err) {
      alert(`Proposal View Error: ${err.message}`);
    }
  }

  function renderProposalModal(proposal) {
    proposalModalFileTitle.textContent = proposal.relativePath;
    proposalModalStatusBadge.className = `badge badge-status-${proposal.status}`;
    proposalModalStatusBadge.textContent = proposal.status.replace(/_/g, ' ').toUpperCase();
    proposalModalIdTag.textContent = `ID: ${proposal.id.slice(0, 8)}...`;

    const diff = proposal.diff || { additions: 0, deletions: 0, unified: '' };
    proposalModalAdds.textContent = `+${diff.additions} additions`;
    proposalModalDels.textContent = `-${diff.deletions} deletions`;

    if (proposal.status === 'conflict') {
      proposalAlertBanner.style.display = 'block';
      proposalAlertBanner.className = 'alert-banner alert-banner-error';
      proposalAlertBanner.textContent = `⚠️ File Conflict: ${proposal.statusReason || 'Underlying file was modified on disk since diff was generated.'}`;
    } else if (proposal.status === 'expired') {
      proposalAlertBanner.style.display = 'block';
      proposalAlertBanner.className = 'alert-banner alert-banner-warning';
      proposalAlertBanner.textContent = '⚠️ Proposal Expired: TTL elapsed before approval.';
    } else if (proposal.status === 'rejected') {
      proposalAlertBanner.style.display = 'block';
      proposalAlertBanner.className = 'alert-banner alert-banner-warning';
      proposalAlertBanner.textContent = `Rejected: ${proposal.rejectionReason || 'User rejected this proposal.'}`;
    } else {
      proposalAlertBanner.style.display = 'none';
    }

    renderDiffLines(diff.unified || '(No changes or identical content)');

    // Control button states based on approval state machine
    if (proposal.status === 'awaiting_approval') {
      proposalSafetyText.textContent = 'Awaiting explicit user review. Zero changes applied before approval.';
      proposalApproveBtn.disabled = false;
      proposalApproveBtn.style.display = 'inline-block';
      proposalRejectBtn.disabled = false;
      proposalRejectBtn.style.display = 'inline-block';
      proposalApplyBtn.disabled = true;
      proposalApplyBtn.title = 'Approve proposal first before applying.';
    } else if (proposal.status === 'approved') {
      proposalSafetyText.textContent = 'Proposal explicitly approved. Ready to apply to disk.';
      proposalApproveBtn.disabled = true;
      proposalApproveBtn.style.display = 'none';
      proposalRejectBtn.disabled = false;
      proposalRejectBtn.style.display = 'inline-block';
      proposalApplyBtn.disabled = false;
      proposalApplyBtn.title = 'Apply changes safely to disk with backup.';
    } else if (proposal.status === 'applied') {
      proposalSafetyText.textContent = `✓ Successfully applied to disk (${proposal.backupPath ? 'backup created' : 'new file'}).`;
      proposalApproveBtn.disabled = true;
      proposalApproveBtn.style.display = 'none';
      proposalRejectBtn.disabled = true;
      proposalRejectBtn.style.display = 'none';
      proposalApplyBtn.disabled = true;
    } else {
      proposalSafetyText.textContent = `Terminal state: ${proposal.status}. No further actions permitted.`;
      proposalApproveBtn.disabled = true;
      proposalRejectBtn.disabled = true;
      proposalApplyBtn.disabled = true;
    }
  }

  function renderDiffLines(unifiedText) {
    if (!proposalDiffCode) return;
    proposalDiffCode.innerHTML = '';
    const lines = unifiedText.split('\n');

    for (const line of lines) {
      const lineDiv = document.createElement('div');
      lineDiv.className = 'diff-line';

      if (line.startsWith('+') && !line.startsWith('+++')) {
        lineDiv.classList.add('diff-line-add');
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        lineDiv.classList.add('diff-line-del');
      } else if (line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++')) {
        lineDiv.classList.add('diff-line-hdr');
      } else {
        lineDiv.classList.add('diff-line-ctx');
      }

      lineDiv.textContent = line;
      proposalDiffCode.appendChild(lineDiv);
    }
  }

  async function approveProposalAction() {
    if (!currentProposal) return;
    const token = proposalTokens.get(currentProposal.id) || currentProposal.approvalToken;
    if (!token) {
      alert('Missing approval token for this proposal.');
      return;
    }

    proposalApproveBtn.disabled = true;
    proposalApproveBtn.textContent = 'Approving...';

    try {
      const res = await fetch(`/api/project/proposals/${encodeURIComponent(currentProposal.id)}/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ approvalToken: token })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || 'Approval failed.');
      }

      currentProposal = data.proposal;
      renderProposalModal(currentProposal);
      await loadProposals();
    } catch (err) {
      alert(`Approval error: ${err.message}`);
    } finally {
      proposalApproveBtn.textContent = 'Approve Change';
    }
  }

  async function rejectProposalAction() {
    if (!currentProposal) return;
    const reason = prompt('Optional rejection reason:', 'User declined change') || 'User declined change';

    proposalRejectBtn.disabled = true;
    proposalRejectBtn.textContent = 'Rejecting...';

    try {
      const res = await fetch(`/api/project/proposals/${encodeURIComponent(currentProposal.id)}/reject`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ reason })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || 'Rejection failed.');
      }

      currentProposal = data.proposal;
      renderProposalModal(currentProposal);
      await loadProposals();
    } catch (err) {
      alert(`Rejection error: ${err.message}`);
    } finally {
      proposalRejectBtn.textContent = 'Reject';
    }
  }

  async function applyProposalAction() {
    if (!currentProposal) return;
    const token = proposalTokens.get(currentProposal.id) || currentProposal.approvalToken;
    if (!token) {
      alert('Missing approval token for this proposal.');
      return;
    }

    proposalApplyBtn.disabled = true;
    proposalApplyBtn.textContent = 'Applying to disk...';

    try {
      const res = await fetch(`/api/project/proposals/${encodeURIComponent(currentProposal.id)}/apply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ approvalToken: token })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || 'Failed to apply changes.');
      }

      alert(`Changes applied to disk successfully!\nBackup: ${data.result?.backupPath || 'none'}`);
      await refreshProjectData();
      await openProposalModal(currentProposal.id);
    } catch (err) {
      alert(`Apply error: ${err.message}`);
      await openProposalModal(currentProposal.id);
    } finally {
      proposalApplyBtn.textContent = 'Apply to Disk';
    }
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

  if (aiGenerateBtn) {
    aiGenerateBtn.addEventListener('click', startAiTask);
  }

  if (aiCancelBtn) {
    aiCancelBtn.addEventListener('click', cancelAiTask);
  }

  if (createProposalBtn) {
    createProposalBtn.addEventListener('click', createProposalAction);
  }

  if (proposalModalCloseBtn && proposalModal) {
    proposalModalCloseBtn.addEventListener('click', () => {
      proposalModal.style.display = 'none';
    });

    proposalModal.addEventListener('click', (e) => {
      if (e.target === proposalModal) {
        proposalModal.style.display = 'none';
      }
    });
  }

  if (proposalApproveBtn) {
    proposalApproveBtn.addEventListener('click', approveProposalAction);
  }

  if (proposalRejectBtn) {
    proposalRejectBtn.addEventListener('click', rejectProposalAction);
  }

  if (proposalApplyBtn) {
    proposalApplyBtn.addEventListener('click', applyProposalAction);
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
      Promise.all([fetchStatus(), fetchHealth(), refreshProjectData(), loadProposals()]).finally(() => {
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'Refresh Status';
      });
    });
  }

  // Initial load
  fetchStatus();
  fetchHealth();
  checkActiveProject();
  loadProposals();
  loadAiModels();

  // Background polling every 10 seconds
  setInterval(() => {
    fetchStatus();
    fetchHealth();
  }, 10000);
})();
