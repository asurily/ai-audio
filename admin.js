const $ = (id) => document.getElementById(id);
const successStatuses = new Set(['completed', 'succeeded', 'success', 'done']);
const failedStatuses = new Set(['failed', 'error', 'canceled', 'cancelled']);
let refreshing = false;
let timer = null;

function statusInfo(status) {
  const value = String(status || 'queued').toLowerCase();
  if (successStatuses.has(value)) return { label: '已完成', kind: 'success' };
  if (failedStatuses.has(value)) return { label: value.startsWith('cancel') ? '已取消' : '生成失败', kind: 'failed' };
  if (value === 'queued' || value === 'pending') return { label: '排队中', kind: 'queued' };
  return { label: '生成中', kind: 'active' };
}

function formatElapsed(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '—';
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}分 ${seconds}秒` : `${seconds}秒`;
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
}

function createCell(row, className = '') {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  row.append(cell);
  return cell;
}

function renderRows(items) {
  const body = $('taskRows');
  body.replaceChildren();
  $('emptyState').classList.toggle('hidden', items.length > 0);
  items.forEach((task) => {
    const row = document.createElement('tr');
    const idCell = createCell(row);
    const idWrap = document.createElement('div');
    idWrap.className = 'task-id';
    const code = document.createElement('code');
    code.textContent = task.id;
    code.title = task.id;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'copy-button';
    copy.textContent = '⧉';
    copy.title = '复制任务 ID';
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(task.id);
      copy.textContent = '✓';
      setTimeout(() => { copy.textContent = '⧉'; }, 1200);
    });
    idWrap.append(code, copy);
    idCell.append(idWrap);
    createCell(row, 'model').textContent = task.model || '—';
    createCell(row, 'duration').textContent = task.duration ? `${task.duration} 秒` : '—';
    const info = statusInfo(task.status);
    const statusCell = createCell(row);
    const badge = document.createElement('span');
    badge.className = `status ${info.kind}`;
    badge.textContent = info.label;
    if (info.kind === 'failed') badge.title = task.error ? String(task.error) : `上游未提供失败原因；任务 ID：${task.id}`;
    statusCell.append(badge);
    createCell(row, 'elapsed').textContent = formatElapsed(task.elapsedMs);
    createCell(row).textContent = formatTime(task.createdAt);
    const downloadCell = createCell(row);
    if (task.downloadUrl) {
      const link = document.createElement('a');
      link.className = 'download';
      link.href = task.downloadUrl;
      link.download = `video-${task.id}.mp4`;
      link.textContent = '下载 ↓';
      downloadCell.append(link);
    } else {
      const unavailable = document.createElement('span');
      unavailable.className = 'unavailable';
      unavailable.textContent = '暂不可用';
      downloadCell.append(unavailable);
    }
    body.append(row);
  });
}

function renderStats(items) {
  let active = 0;
  let success = 0;
  let failed = 0;
  items.forEach((task) => {
    const kind = statusInfo(task.status).kind;
    if (kind === 'success') success += 1;
    else if (kind === 'failed') failed += 1;
    else active += 1;
  });
  $('totalCount').textContent = items.length;
  $('activeCount').textContent = active;
  $('successCount').textContent = success;
  $('failedCount').textContent = failed;
}

async function loadTasks() {
  if (refreshing) return;
  refreshing = true;
  $('refreshButton').disabled = true;
  $('refreshButton').classList.add('refreshing');
  $('errorMessage').classList.add('hidden');
  try {
    const response = await fetch('/api/admin/videos?refresh=1');
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
    const items = Array.isArray(data.items) ? data.items : [];
    renderRows(items);
    renderStats(items);
    $('loadingState').classList.add('hidden');
    $('updatedAt').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  } catch (error) {
    $('loadingState').classList.add('hidden');
    $('errorMessage').textContent = `任务加载失败：${error.message}`;
    $('errorMessage').classList.remove('hidden');
  } finally {
    refreshing = false;
    $('refreshButton').disabled = false;
    $('refreshButton').classList.remove('refreshing');
    clearTimeout(timer);
    timer = setTimeout(loadTasks, 20_000);
  }
}

$('refreshButton').addEventListener('click', loadTasks);
loadTasks();
