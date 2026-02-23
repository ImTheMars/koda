/**
 * Koda Dashboard — lightweight read-only web UI served by the Bun health server.
 *
 * Routes:
 *   GET /            → full HTML dashboard page
 *   GET /api/usage   → { today, month, allTime }
 *   GET /api/skills  → { skills[] }
 *   GET /api/tasks   → { tasks[] }
 *   GET /api/spawns  → { spawns[] }  (SQLite-backed, latest 50)
 *   GET /api/events  → SSE stream (spawn on state change, heartbeat every 30s)
 *   DELETE /api/spawns?session=key → kill a running sub-agent
 */

import type { SkillLoader } from "./tools/skills.js";
import type { Config } from "./config.js";
import { usage as dbUsage, tasks as dbTasks } from "./db.js";
import { getSpawnLog, killSpawn } from "./tools/subagent.js";
import { subscribe } from "./events.js";

export interface DashboardDeps {
  skillLoader: SkillLoader;
  defaultUserId: string;
  config: Config;
  version: string;
}

// --- API handlers ---

function usageResponse(userId: string): Response {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return Response.json({
    today: dbUsage.getSummary(userId, todayStart),
    month: dbUsage.getSummary(userId, monthStart),
    allTime: dbUsage.getSummary(userId),
  });
}

async function skillsResponse(skillLoader: SkillLoader): Promise<Response> {
  const skills = await skillLoader.listSkills();
  return Response.json({ skills });
}

function tasksResponse(userId: string): Response {
  const tasks = dbTasks.listByUser(userId);
  return Response.json({ tasks });
}

function spawnsResponse(): Response {
  return Response.json({ spawns: getSpawnLog() });
}

function sseResponse(): Response {
  const encoder = new TextEncoder();
  let unsub: (() => void) | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(ctrl) {
      function send(name: string, data: unknown) {
        try {
          ctrl.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {}
      }

      send("init", { ok: true });
      unsub = subscribe((name, data) => send(name, data));
      heartbeatTimer = setInterval(() => send("heartbeat", {}), 30_000);
    },
    cancel() {
      unsub?.();
      clearInterval(heartbeatTimer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// --- Route handler ---

export async function handleDashboardRequest(req: Request, deps: DashboardDeps): Promise<Response | null> {
  const url = new URL(req.url);

  if (url.pathname === "/api/usage") return usageResponse(deps.defaultUserId);
  if (url.pathname === "/api/skills") return skillsResponse(deps.skillLoader);
  if (url.pathname === "/api/tasks") return tasksResponse(deps.defaultUserId);
  if (url.pathname === "/api/events") return sseResponse();

  if (url.pathname === "/api/spawns") {
    if (req.method === "DELETE") {
      const sessionKey = url.searchParams.get("session") ?? "";
      const ok = killSpawn(sessionKey);
      return Response.json({ killed: ok, sessionKey });
    }
    return spawnsResponse();
  }

  if (url.pathname === "/") return new Response(buildDashboardHtml(deps), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

  return null;
}

// --- HTML ---

function buildDashboardHtml(deps: DashboardDeps): string {
  const { version, config } = deps;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Koda</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #0d0d0f;
      --surface: #17171a;
      --surface2: #1e1e22;
      --border: #2a2a30;
      --text: #e8e8ed;
      --muted: #7a7a85;
      --accent: #7c6aff;
      --accent2: #5eead4;
      --green: #34d399;
      --yellow: #fbbf24;
      --red: #f87171;
      --radius: 10px;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      --mono: "SF Mono", "Fira Code", "Cascadia Code", monospace;
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
      font-size: 14px;
      line-height: 1.6;
      min-height: 100vh;
    }

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 28px;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
      position: sticky;
      top: 0;
      z-index: 10;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 17px;
      font-weight: 600;
      letter-spacing: -0.3px;
    }

    .logo-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--green);
      box-shadow: 0 0 8px var(--green);
      flex-shrink: 0;
      transition: background 0.3s, box-shadow 0.3s;
    }

    .version { font-size: 11px; color: var(--muted); font-family: var(--mono); }

    .status-info {
      font-size: 12px;
      color: var(--muted);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .sse-badge {
      font-size: 10px;
      font-family: var(--mono);
      padding: 2px 7px;
      border-radius: 10px;
      background: rgba(52, 211, 153, 0.1);
      color: var(--green);
      border: 1px solid rgba(52, 211, 153, 0.2);
    }

    .sse-badge.offline {
      background: rgba(248, 113, 113, 0.1);
      color: var(--red);
      border-color: rgba(248, 113, 113, 0.2);
    }

    .main {
      max-width: 1100px;
      margin: 0 auto;
      padding: 28px 24px;
      display: flex;
      flex-direction: column;
      gap: 28px;
    }

    /* --- Info bar --- */
    .info-bar {
      display: flex;
      gap: 24px;
      font-size: 12px;
      font-family: var(--mono);
      color: var(--muted);
      padding: 12px 18px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      flex-wrap: wrap;
    }

    .info-bar span { white-space: nowrap; }
    .info-label { color: var(--muted); margin-right: 4px; }
    .info-value { color: var(--text); font-weight: 600; }

    /* --- Usage cards --- */
    .usage-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 14px;
    }

    @media (max-width: 700px) { .usage-grid { grid-template-columns: 1fr; } }

    .usage-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px 22px;
    }

    .usage-card-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      margin-bottom: 10px;
    }

    .usage-card-cost {
      font-size: 26px;
      font-weight: 700;
      font-family: var(--mono);
      color: var(--text);
      letter-spacing: -0.5px;
    }

    .usage-card-meta {
      margin-top: 6px;
      font-size: 12px;
      color: var(--muted);
    }

    /* --- Section --- */
    .section {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
    }

    .section-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      letter-spacing: -0.2px;
    }

    .badge {
      background: var(--surface2);
      border: 1px solid var(--border);
      color: var(--muted);
      font-size: 11px;
      font-family: var(--mono);
      padding: 2px 8px;
      border-radius: 20px;
    }

    /* --- Skills table --- */
    .skills-list { list-style: none; }

    .skill-row {
      display: flex;
      align-items: flex-start;
      gap: 14px;
      padding: 14px 20px;
      border-bottom: 1px solid var(--border);
    }

    .skill-row:last-child { border-bottom: none; }

    .skill-icon {
      width: 32px;
      height: 32px;
      border-radius: 7px;
      background: var(--surface2);
      border: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      flex-shrink: 0;
      margin-top: 1px;
    }

    .skill-body { flex: 1; min-width: 0; }

    .skill-name {
      font-size: 13px;
      font-weight: 600;
      font-family: var(--mono);
      color: var(--text);
    }

    .skill-desc {
      font-size: 12px;
      color: var(--muted);
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .skill-source {
      font-size: 10px;
      font-family: var(--mono);
      padding: 2px 7px;
      border-radius: 4px;
      flex-shrink: 0;
      align-self: center;
    }

    .source-builtin {
      background: rgba(124, 106, 255, 0.12);
      color: var(--accent);
      border: 1px solid rgba(124, 106, 255, 0.25);
    }

    .source-workspace {
      background: rgba(94, 234, 212, 0.1);
      color: var(--accent2);
      border: 1px solid rgba(94, 234, 212, 0.2);
    }

    /* --- Tasks table --- */
    .tasks-list { list-style: none; }

    .task-row {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 13px 20px;
      border-bottom: 1px solid var(--border);
    }

    .task-row:last-child { border-bottom: none; }

    .task-type {
      font-size: 10px;
      font-family: var(--mono);
      padding: 2px 7px;
      border-radius: 4px;
      flex-shrink: 0;
    }

    .type-reminder {
      background: rgba(251, 191, 36, 0.1);
      color: var(--yellow);
      border: 1px solid rgba(251, 191, 36, 0.2);
    }

    .type-recurring {
      background: rgba(94, 234, 212, 0.1);
      color: var(--accent2);
      border: 1px solid rgba(94, 234, 212, 0.2);
    }

    .task-desc {
      flex: 1;
      font-size: 13px;
      color: var(--text);
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .task-time {
      font-size: 11px;
      font-family: var(--mono);
      color: var(--muted);
      white-space: nowrap;
    }

    /* --- Spawn rows --- */
    .spawns-list { list-style: none; }

    .spawn-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 11px 20px;
      border-bottom: 1px solid var(--border);
      font-size: 12px;
    }

    .spawn-row:last-child { border-bottom: none; }

    .spawn-status {
      font-size: 13px;
      flex-shrink: 0;
      width: 16px;
      text-align: center;
    }

    .spawn-name {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--text);
      flex-shrink: 0;
      min-width: 130px;
    }

    .spawn-tools {
      flex: 1;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .spawn-meta {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--muted);
      white-space: nowrap;
    }

    .kill-btn {
      background: none;
      border: 1px solid var(--border);
      color: var(--muted);
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      cursor: pointer;
      flex-shrink: 0;
      transition: color 0.15s, border-color 0.15s;
    }
    .kill-btn:hover { color: var(--red); border-color: var(--red); }

    /* --- Empty state --- */
    .empty {
      padding: 36px 20px;
      text-align: center;
      color: var(--muted);
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div class="topbar">
    <div class="logo">
      <div class="logo-dot" id="statusDot"></div>
      Koda
      <span class="version">v${version}</span>
    </div>
    <div class="status-info">
      <span class="sse-badge" id="sseBadge">live</span>
      <span id="refreshInfo">connecting...</span>
    </div>
  </div>

  <div class="main">
    <!-- Info bar -->
    <div class="info-bar" id="infoBar">
      <span><span class="info-label">fast</span><span class="info-value">${escapeHtml(config.openrouter.fastModel)}</span></span>
      <span><span class="info-label">deep</span><span class="info-value">${escapeHtml(config.openrouter.deepModel)}</span></span>
      <span><span class="info-label">uptime</span><span class="info-value" id="uptimeVal">—</span></span>
    </div>

    <!-- Usage -->
    <div class="usage-grid" id="usageGrid">
      <div class="usage-card"><div class="usage-card-label">Today</div><div class="usage-card-cost">—</div></div>
      <div class="usage-card"><div class="usage-card-label">This Month</div><div class="usage-card-cost">—</div></div>
      <div class="usage-card"><div class="usage-card-label">All Time</div><div class="usage-card-cost">—</div></div>
    </div>

    <!-- Skills -->
    <div class="section">
      <div class="section-header">
        <span class="section-title">Skills</span>
        <span class="badge" id="skillsBadge">—</span>
      </div>
      <ul class="skills-list" id="skillsList">
        <li class="empty">Loading...</li>
      </ul>
    </div>

    <!-- Tasks -->
    <div class="section">
      <div class="section-header">
        <span class="section-title">Scheduled Tasks</span>
        <span class="badge" id="tasksBadge">—</span>
      </div>
      <ul class="tasks-list" id="tasksList">
        <li class="empty">Loading...</li>
      </ul>
    </div>

    <!-- Sub-agent activity -->
    <div class="section">
      <div class="section-header">
        <span class="section-title">Sub-Agent Activity</span>
        <span class="badge" id="spawnsBadge">—</span>
      </div>
      <ul class="spawns-list" id="spawnsList">
        <li class="empty">Loading...</li>
      </ul>
    </div>
  </div>

  <script>
    const SKILL_ICONS = { builtin: '⚡', workspace: '✦' };
    const SPAWN_STATUS = { done: '✓', error: '✗', timeout: '⏱', running: '·', killed: '✕' };
    const SPAWN_COLOR = { done: 'var(--green)', error: 'var(--red)', timeout: 'var(--yellow)', running: 'var(--accent)', killed: 'var(--muted)' };

    function esc(str) {
      const d = document.createElement('div');
      d.textContent = str;
      return d.innerHTML;
    }

    let spawnList = [];

    function fmt(cost) {
      return cost < 0.01 ? '<$0.01' : '$' + cost.toFixed(3);
    }

    function relTime(isoStr) {
      if (!isoStr) return '—';
      const d = new Date(isoStr);
      const diff = d - Date.now();
      const abs = Math.abs(diff);
      const mins = Math.floor(abs / 60000);
      const hrs = Math.floor(abs / 3600000);
      const days = Math.floor(abs / 86400000);
      const prefix = diff < 0 ? 'overdue' : 'in';
      if (mins < 1) return diff < 0 ? 'overdue' : 'now';
      if (hrs < 1) return prefix + ' ' + mins + 'm';
      if (days < 1) return prefix + ' ' + hrs + 'h';
      return prefix + ' ' + days + 'd';
    }

    function ago(isoStr) {
      if (!isoStr) return '—';
      const diff = Date.now() - new Date(isoStr).getTime();
      const mins = Math.floor(diff / 60000);
      const hrs = Math.floor(diff / 3600000);
      if (mins < 1) return 'just now';
      if (hrs < 1) return mins + 'm ago';
      return hrs + 'h ago';
    }

    function fmtUptime() {
      // We don't have server uptime directly in SSE — compute from page load as estimate
      const el = document.getElementById('uptimeVal');
      if (!el) return;
      fetch('/health').then(r => r.json()).then(d => {
        const s = Math.floor(d.uptime);
        if (s < 60) el.textContent = s + 's';
        else if (s < 3600) el.textContent = Math.floor(s/60) + 'm';
        else el.textContent = Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
      }).catch(() => {});
    }

    function setStatus(online) {
      const dot = document.getElementById('statusDot');
      const badge = document.getElementById('sseBadge');
      if (online) {
        dot.style.background = '#34d399';
        dot.style.boxShadow = '0 0 8px #34d399';
        badge.textContent = 'live';
        badge.className = 'sse-badge';
      } else {
        dot.style.background = '#f87171';
        dot.style.boxShadow = '0 0 8px #f87171';
        badge.textContent = 'offline';
        badge.className = 'sse-badge offline';
      }
    }

    function renderUsage(data) {
      const cards = [
        { label: 'Today', d: data.today },
        { label: 'This Month', d: data.month },
        { label: 'All Time', d: data.allTime },
      ];
      document.getElementById('usageGrid').innerHTML = cards.map(function(c) {
        var d = c.d;
        var toolLine = d.totalToolCost > 0 ? '<div class="usage-card-meta" style="margin-top:2px">+' + fmt(d.totalToolCost) + ' tools</div>' : '';
        return '<div class="usage-card">' +
          '<div class="usage-card-label">' + c.label + '</div>' +
          '<div class="usage-card-cost">' + fmt(d.totalCost) + '</div>' +
          '<div class="usage-card-meta">' + d.totalRequests + ' requests &middot; ' + (d.totalInputTokens + d.totalOutputTokens).toLocaleString() + ' tokens</div>' +
          toolLine +
          '</div>';
      }).join('');
    }

    function renderSkills(data) {
      var list = document.getElementById('skillsList');
      document.getElementById('skillsBadge').textContent = data.skills.length;
      if (!data.skills.length) {
        list.innerHTML = '<li class="empty">No skills installed</li>';
        return;
      }
      list.innerHTML = data.skills.map(function(s) {
        return '<li class="skill-row">' +
          '<div class="skill-icon">' + (SKILL_ICONS[s.source] || '◆') + '</div>' +
          '<div class="skill-body">' +
          '<div class="skill-name">' + esc(s.name) + '</div>' +
          '<div class="skill-desc">' + esc(s.description) + '</div>' +
          '</div>' +
          '<span class="skill-source source-' + esc(s.source) + '">' + esc(s.source) + '</span>' +
          '</li>';
      }).join('');
    }

    function renderTasks(data) {
      var list = document.getElementById('tasksList');
      document.getElementById('tasksBadge').textContent = data.tasks.length;
      if (!data.tasks.length) {
        list.innerHTML = '<li class="empty">No scheduled tasks</li>';
        return;
      }
      list.innerHTML = data.tasks.map(function(t) {
        return '<li class="task-row">' +
          '<span class="task-type type-' + esc(t.type) + '">' + esc(t.type) + '</span>' +
          '<span class="task-desc">' + esc(t.description) + '</span>' +
          '<span class="task-time">' + relTime(t.nextRunAt) + '</span>' +
          '</li>';
      }).join('');
    }

    async function killAgent(sessionKey) {
      await fetch('/api/spawns?session=' + encodeURIComponent(sessionKey), { method: 'DELETE' });
    }

    function renderSpawns(spawns) {
      var list = document.getElementById('spawnsList');
      document.getElementById('spawnsBadge').textContent = spawns.length;
      if (!spawns.length) {
        list.innerHTML = '<li class="empty">No sub-agents spawned yet</li>';
        return;
      }
      list.innerHTML = spawns.slice(0, 20).map(function(s) {
        var durationStr = s.durationMs > 0 ? (s.durationMs / 1000).toFixed(1) + 's' : '';
        return '<li class="spawn-row">' +
          '<span class="spawn-status" style="color:' + (SPAWN_COLOR[s.status] || 'var(--muted)') + '">' + (SPAWN_STATUS[s.status] || '·') + '</span>' +
          '<span class="spawn-name">' + esc(s.name) + '</span>' +
          '<span class="spawn-tools">' + esc(s.toolsUsed.join(', ') || '—') + '</span>' +
          '<span class="spawn-meta">' + (s.cost > 0 ? '$' + s.cost.toFixed(4) + ' ' : '') + (durationStr ? durationStr + ' ' : '') + ago(s.startedAt) + '</span>' +
          (s.status === 'running' ? '<button class="kill-btn" onclick="killAgent(\\'' + esc(s.sessionKey) + '\\')">kill</button>' : '') +
          '</li>';
      }).join('');
    }

    function updateSpawnEntry(entry) {
      var idx = spawnList.findIndex(function(s) { return s.sessionKey === entry.sessionKey; });
      if (idx >= 0) {
        spawnList[idx] = entry;
      } else {
        spawnList.unshift(entry);
        if (spawnList.length > 50) spawnList.pop();
      }
      renderSpawns(spawnList);
    }

    async function refresh() {
      try {
        var results = await Promise.all([
          fetch('/api/usage').then(function(r) { return r.json(); }),
          fetch('/api/skills').then(function(r) { return r.json(); }),
          fetch('/api/tasks').then(function(r) { return r.json(); }),
          fetch('/api/spawns').then(function(r) { return r.json(); }),
        ]);
        renderUsage(results[0]);
        renderSkills(results[1]);
        renderTasks(results[2]);
        spawnList = results[3].spawns || [];
        renderSpawns(spawnList);
        fmtUptime();
        var now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        document.getElementById('refreshInfo').textContent = 'updated ' + now;
      } catch (e) {
        document.getElementById('refreshInfo').textContent = 'fetch error';
      }
    }

    function connectSSE() {
      var es = new EventSource('/api/events');
      es.onopen = function() { setStatus(true); };
      es.onerror = function() { setStatus(false); };
      es.addEventListener('init', function() { refresh(); });
      es.addEventListener('heartbeat', function() { refresh(); });
      es.addEventListener('spawn', function(e) {
        try { updateSpawnEntry(JSON.parse(e.data)); } catch(err) {}
      });
    }

    connectSSE();
  </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
