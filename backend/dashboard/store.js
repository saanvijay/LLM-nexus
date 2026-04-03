// In-memory log store. Keeps the last MAX entries and broadcasts new ones
// to all active SSE clients (the dashboard UI).

const MAX = 200;
const logs = [];
const clients = new Set();

function push(entry) {
  entry.id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  entry.timestamp = new Date().toISOString();
  logs.unshift(entry);           // newest first
  if (logs.length > MAX) logs.pop();
  _broadcast(entry);
}

function all() {
  return logs;
}

function subscribe(res) {
  clients.add(res);
  return () => clients.delete(res);
}

function _broadcast(entry) {
  const line = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of clients) {
    try { res.write(line); } catch { clients.delete(res); }
  }
}

module.exports = { push, all, subscribe };
