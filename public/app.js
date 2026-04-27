// Global state
let ws = null;
let isEditorHtml = true;
let consoleLogs = [];

// 📦 HTML Template Database
const HTML_TEMPLATES = [
  { id: 'welcome', name: '📧 Welcome Email', content: `<h1 style="color: #3b82f6;">Welcome to Our Platform!</h1><p>Hi there,</p><p>Thank you for joining us. We're excited to have you on board.</p><p>Best regards,<br>The Team</p>` },
  { id: 'promo', name: '🔥 Special Promotion', content: `<div style="background: #f8fafc; padding: 20px; border-radius: 8px; border: 1px solid #e2e8f0;"><h2 style="color: #ef4444; margin-top: 0;">🎉 Limited Time Offer!</h2><p>Get <strong>50% OFF</strong> your next purchase.</p><p>Use code: <code style="background: #e2e8f0; padding: 4px 8px; border-radius: 4px;">SAVE50</code></p></div>` },
  { id: 'newsletter', name: '📰 Monthly Newsletter', content: `<h2>📅 This Month's Updates</h2><ul><li>Feature 1 released</li><li>Community growth: +20%</li><li>Upcoming webinar</li></ul><p>Stay tuned for more!</p>` },
  { id: 'transactional', name: '🔑 Password Reset', content: `<p>Hello,</p><p>We received a request to reset your password. Click below to proceed:</p><p><a href="#" style="background: #3b82f6; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">Reset Password</a></p><p><small>If you didn't request this, please ignore this email.</small></p>` }
];

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  connectWebSocket();
  setupEventListeners();
  loadTheme();
  populateTemplates();
});

// WebSocket Connection
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}`);
  ws.onopen = () => {
    updateConnectionStatus(true);
    addLog('Connected to server', 'info');
  };
  ws.onclose = () => {
    updateConnectionStatus(false);
    addLog('Disconnected from server. Reconnecting...', 'warning');
    setTimeout(connectWebSocket, 3000);
  };
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleServerMessage(data);
  };
  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };
}

function updateConnectionStatus(connected) {
  const status = document.getElementById('connectionStatus');
  const dot = status.querySelector('.status-dot');
  const text = status.querySelector('.status-text');
  if (connected) {
    dot.style.background = '#10b981';
    text.textContent = 'Connected';
  } else {
    dot.style.background = '#ef4444';
    text.textContent = 'Disconnected';
  }
}

function handleServerMessage(data) {
  switch(data.type) {
    case 'status':
      addLog(data.message, 'info');
      break;
    case 'email_sent':
      addLog(`✓ Sent to ${data.email}`, 'success');
      updateProgress(data.progress, data.stats);
      break;
    case 'email_failed':
      addLog(`✗ Failed to ${data.email}: ${data.error}`, 'error');
      updateStats(data.stats);
      break;
    case 'smtp_rotate':
      addLog(`🔄 Rotated to SMTP server #${data.index + 1}`, 'warning');
      break;
    case 'completed':
      addLog(`🎉 Campaign completed! Sent: ${data.stats.sent}, Failed: ${data.stats.failed}`, 'success');
      showToast('Email campaign completed!', 'success');
      resetButtons();
      break;
  }
}

function updateProgress(progress, stats) {
  const fill = document.getElementById('progressFill');
  const percentage = progress.percentage;
  fill.style.width = `${percentage}%`;
  document.getElementById('statTotal').textContent = stats.total;
  document.getElementById('statSent').textContent = stats.sent;
  document.getElementById('statFailed').textContent = stats.failed;
  document.getElementById('statProgress').textContent = `${percentage}%`;
}

function updateStats(stats) {
  document.getElementById('statTotal').textContent = stats.total;
  document.getElementById('statSent').textContent = stats.sent;
  document.getElementById('statFailed').textContent = stats.failed;
}

// Event Listeners
function setupEventListeners() {
  document.getElementById('recipients').addEventListener('input', updateRecipientCount);
  document.getElementById('smtpList').addEventListener('input', updateSMTPCount);
  document.getElementById('themeToggle').addEventListener('click', toggleTheme);
  
  // Template & Preview Listeners
  document.getElementById('templateSelect').addEventListener('change', handleTemplateChange);
  document.getElementById('messageBody').addEventListener('input', debounce(updatePreview, 250));
}

function updateRecipientCount() {
  const text = document.getElementById('recipients').value;
  const count = text.split('\n').filter(e => e.trim()).length;
  document.getElementById('recipientCount').textContent = `${count} recipient${count !== 1 ? 's' : ''}`;
}

function updateSMTPCount() {
  const text = document.getElementById('smtpList').value;
  const count = text.split('\n').filter(e => e.trim()).length;
  document.getElementById('smtpCount').textContent = `${count} server${count !== 1 ? 's' : ''} configured`;
}

// SMTP Management
function addSMTP() {
  const host = document.getElementById('smtpHost').value.trim();
  const port = document.getElementById('smtpPort').value || '465';
  const user = document.getElementById('smtpUser').value.trim();
  const pass = document.getElementById('smtpPass').value;
  const security = document.querySelector('input[name="security"]:checked').value;
  if (!host || !user || !pass) {
    showToast('Please fill in all required fields', 'error');
    return;
  }
  const entry = `${host}|${user}|${pass}|${port}|${security}`;
  const listEl = document.getElementById('smtpList');
  if (listEl.value) {
    listEl.value += '\n' + entry;
  } else {
    listEl.value = entry;
  }
  document.getElementById('smtpHost').value = '';
  document.getElementById('smtpUser').value = '';
  document.getElementById('smtpPass').value = '';
  updateSMTPCount();
  showToast('SMTP server added successfully', 'success');
  addLog(`Added SMTP: ${host}`, 'info');
}

function clearSMTPList() {
  if (confirm('Are you sure you want to clear the SMTP list?')) {
    document.getElementById('smtpList').value = '';
    updateSMTPCount();
    addLog('SMTP list cleared', 'warning');
  }
}

// Email Sending
async function startSending() {
  const config = {
    smtpList: document.getElementById('smtpList').value,
    senderEmail: document.getElementById('senderEmail').value,
    senderName: document.getElementById('senderName').value,
    replyTo: document.getElementById('replyTo').value,
    subject: document.getElementById('subject').value,
    message: document.getElementById('messageBody').value,
    isHtml: isEditorHtml,
    priority: document.getElementById('priority').value,
    charset: document.getElementById('encoding').value,
    useBcc: document.getElementById('useBcc').checked,
    recipients: document.getElementById('recipients').value,
    changeSmtpEvery: document.getElementById('changeSmtpEvery').value,
    pauseSeconds: document.getElementById('pauseSeconds').value,
    pauseEvery: document.getElementById('pauseEvery').value,
    reconnectAfter: document.getElementById('reconnectAfter').value
  };
  if (!config.smtpList.trim()) { showToast('Please add at least one SMTP server', 'error'); return; }
  if (!config.recipients.trim()) { showToast('Please add at least one recipient', 'error'); return; }
  if (!config.senderEmail || !config.subject) { showToast('Please fill in sender email and subject', 'error'); return; }

  const formData = new FormData();
  formData.append('config', JSON.stringify(config));
  const fileInput = document.getElementById('attachment');
  if (fileInput.files[0]) { formData.append('attachment', fileInput.files[0]); }

  try {
    const response = await fetch('/api/start', { method: 'POST', body: formData });
    const result = await response.json();
    if (result.success) {
      showToast(`Started sending to ${result.total} recipients`, 'success');
      addLog(`Campaign started: ${result.total} emails queued`, 'info');
      document.getElementById('startBtn').disabled = true;
      document.getElementById('stopBtn').disabled = false;
    } else {
      showToast(result.error || 'Failed to start', 'error');
    }
  } catch (error) {
    showToast('Connection error: ' + error.message, 'error');
    addLog('Connection error: ' + error.message, 'error');
  }
}

async function stopSending() {
  try {
    const response = await fetch('/api/stop', { method: 'POST' });
    const result = await response.json();
    if (result.success) {
      showToast('Stopping email sender...', 'warning');
      addLog('Stop requested by user', 'warning');
    }
  } catch (error) {
    showToast('Error stopping: ' + error.message, 'error');
  }
}

function resetButtons() {
  document.getElementById('startBtn').disabled = false;
  document.getElementById('stopBtn').disabled = true;
}

// Console/Logging
function addLog(message, type = 'info') {
  const consoleEl = document.getElementById('consoleLog');
  const time = new Date().toLocaleTimeString();
  const entry = { time, message, type };
  consoleLogs.push(entry);
  const div = document.createElement('div');
  div.className = `log-entry ${type}`;
  div.innerHTML = `<span class="log-time">${time}</span><span class="log-message">${escapeHtml(message)}</span>`;
  consoleEl.appendChild(div);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function clearConsole() {
  document.getElementById('consoleLog').innerHTML = '';
  consoleLogs = [];
  addLog('Console cleared', 'info');
}

function exportLog() {
  const text = consoleLogs.map(log => `[${log.time}] [${log.type.toUpperCase()}] ${log.message}`).join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `email-log-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Log exported', 'success');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Editor Mode Toggle
function toggleEditorMode() {
  isEditorHtml = !isEditorHtml;
  const btn = document.getElementById('editorMode');
  btn.textContent = isEditorHtml ? 'HTML' : 'Text';
  showToast(`Switched to ${isEditorHtml ? 'HTML' : 'Text'} mode`, 'info');
}

// Template & Preview Functions
function populateTemplates() {
  const select = document.getElementById('templateSelect');
  HTML_TEMPLATES.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    select.appendChild(opt);
  });
}

function handleTemplateChange(e) {
  const selected = HTML_TEMPLATES.find(t => t.id === e.target.value);
  if (selected) {
    document.getElementById('messageBody').value = selected.content;
    updatePreview();
    showToast(`Loaded: ${selected.name}`, 'info');
    addLog(`Template loaded: ${selected.name}`, 'info');
  }
}

function updatePreview() {
  const iframe = document.getElementById('htmlPreview');
  const content = document.getElementById('messageBody').value.trim();
  if (!content) {
    iframe.srcdoc = '';
    return;
  }
  iframe.srcdoc = `<!DOCTYPE html><html><head><style>body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 15px; line-height: 1.5; color: #1e293b; } a { color: #3b82f6; } img { max-width: 100%; height: auto; } table { border-collapse: collapse; width: 100%; }</style></head><body>${content}</body></html>`;
}

function debounce(func, wait) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

// Theme Management
function toggleTheme() {
  const html = document.documentElement;
  const currentTheme = html.getAttribute('data-theme');
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
  const icon = document.querySelector('#themeToggle i');
  icon.className = newTheme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
}

function loadTheme() {
  const savedTheme = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);
  const icon = document.querySelector('#themeToggle i');
  icon.className = savedTheme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
}

// Toast Notifications
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s ease reverse';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!document.getElementById('startBtn').disabled) { startSending(); }
    }
    if (e.key === 's') {
      e.preventDefault();
      if (!document.getElementById('stopBtn').disabled) { stopSending(); }
    }
  }
});