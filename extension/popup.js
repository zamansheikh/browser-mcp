const $ = (id) => document.getElementById(id);
const LABELS = { connected: 'Connected to MCP server', standby: 'Standby', connecting: 'Connecting…', disconnected: 'Not connected' };

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: 'getStatus' });
  if (!s) return;
  $('dot').className = 'dot ' + s.state;
  $('state').textContent = LABELS[s.state] || s.state;
  $('detail').textContent = s.state === 'connected'
    ? `ws://127.0.0.1:${s.port} · ${s.commandCount} commands this session`
    : s.state === 'standby'
      ? 'Another browser with Pagewright is active. This one takes over if that browser closes.'
      : s.lastError || `Waiting for an agent to start browser-mcp on port ${s.port}.`;
  if (document.activeElement !== $('port')) $('port').value = s.port;
  const ul = $('tabs');
  ul.replaceChildren();
  if (!s.controlled.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'None yet.';
    ul.append(li);
  }
  for (const t of s.controlled) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.className = 't';
    span.textContent = t.title || t.url;
    span.title = t.url;
    const b = document.createElement('button');
    b.className = 'secondary';
    b.textContent = 'Release';
    b.onclick = async () => { await chrome.runtime.sendMessage({ type: 'detach', tabId: t.tabId }); refresh(); };
    li.append(span, b);
    ul.append(li);
  }
}

$('save').onclick = async () => { await chrome.runtime.sendMessage({ type: 'setPort', port: $('port').value }); setTimeout(refresh, 400); };
$('reconnect').onclick = async () => { await chrome.runtime.sendMessage({ type: 'reconnect' }); setTimeout(refresh, 400); };
$('detachAll').onclick = async () => { await chrome.runtime.sendMessage({ type: 'detach' }); refresh(); };
chrome.runtime.onMessage.addListener((m) => { if (m.type === 'statusChanged') refresh(); });
refresh();
setInterval(refresh, 2000);
