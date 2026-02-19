/**
 * Koda Dashboard — lightweight read-only web UI served by the Bun health server.
 *
 * Routes:
 *   GET /            → full HTML dashboard page
 *   GET /api/usage   → { today, month, allTime }
 *   GET /api/skills  → { skills[] }
 *   GET /api/tasks   → { tasks[] }
 *   GET /api/spawns   → { spawns[] }  (in-memory ring buffer from subagent.ts)
 *   GET /api/memory   → { samples[] } (process.memoryUsage() ring buffer)
 *   DELETE /api/spawns?session=key → kill a running sub-agent
 */

import type { SkillLoader } from "./tools/skills.js";
import { usage as dbUsage, tasks as dbTasks } from "./db.js";
import { getSpawnLog, killSpawn } from "./tools/subagent.js";
import { getMemSamples } from "./metrics.js";

export interface DashboardDeps {
  skillLoader: SkillLoader;
  defaultUserId: string;
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

function memoryResponse(): Response {
  return Response.json({ samples: getMemSamples() });
}

// --- Route handler ---

export async function handleDashboardRequest(req: Request, deps: DashboardDeps): Promise<Response | null> {
  const url = new URL(req.url);

  if (url.pathname === "/api/usage") return usageResponse(deps.defaultUserId);
  if (url.pathname === "/api/skills") return skillsResponse(deps.skillLoader);
  if (url.pathname === "/api/tasks") return tasksResponse(deps.defaultUserId);
  if (url.pathname === "/api/spawns") return spawnsResponse();
  if (url.pathname === "/api/memory") return memoryResponse();
  if (req.method === "DELETE" && url.pathname === "/api/spawns") {
    const sessionKey = url.searchParams.get("session") ?? "";
    const ok = killSpawn(sessionKey);
    return Response.json({ killed: ok, sessionKey });
  }
  if (url.pathname === "/") return new Response(buildDashboardHtml(deps.version), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

  return null;
}

// --- HTML ---

export function buildDashboardHtml(version: string): string {
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
    }

    .version {
      font-size: 11px;
      color: var(--muted);
      font-family: var(--mono);
    }

    .refresh-info {
      font-size: 12px;
      color: var(--muted);
    }

    .main {
      max-width: 1100px;
      margin: 0 auto;
      padding: 28px 24px;
      display: flex;
      flex-direction: column;
      gap: 28px;
    }

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
    .skills-list {
      list-style: none;
    }

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

    /* --- RAM graph --- */
    .ram-section {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
    }

    .ram-body {
      padding: 16px 20px 12px;
    }

    .ram-stats {
      display: flex;
      gap: 24px;
      margin-bottom: 12px;
      font-size: 12px;
      font-family: var(--mono);
    }

    .ram-stat-label { color: var(--muted); margin-right: 4px; }
    .ram-stat-value { color: var(--text); font-weight: 600; }

    .ram-chart {
      width: 100%;
      height: 60px;
      display: block;
    }

    /* --- Empty state --- */
    .empty {
      padding: 36px 20px;
      text-align: center;
      color: var(--muted);
      font-size: 13px;
    }

    /* --- Skeleton --- */
    .skeleton {
      height: 18px;
      border-radius: 5px;
      background: linear-gradient(90deg, var(--surface2) 25%, var(--border) 50%, var(--surface2) 75%);
      background-size: 200% 100%;
      animation: shimmer 1.4s infinite;
    }

    @keyframes shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
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
    <div class="refresh-info" id="refreshInfo">loading...</div>
  </div>

  <div class="main">
    <!-- Usage -->
    <div class="usage-grid" id="usageGrid">
      <div class="usage-card"><div class="usage-card-label">Today</div><div class="skeleton" style="width:80px;height:26px;margin-bottom:8px"></div><div class="skeleton" style="width:120px;height:12px"></div></div>
      <div class="usage-card"><div class="usage-card-label">This Month</div><div class="skeleton" style="width:80px;height:26px;margin-bottom:8px"></div><div class="skeleton" style="width:120px;height:12px"></div></div>
      <div class="usage-card"><div class="usage-card-label">All Time</div><div class="skeleton" style="width:80px;height:26px;margin-bottom:8px"></div><div class="skeleton" style="width:120px;height:12px"></div></div>
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

    <!-- RAM graph -->
    <div class="ram-section">
      <div class="section-header">
        <span class="section-title">Memory</span>
        <span class="badge" id="ramBadge">—</span>
      </div>
      <div class="ram-body">
        <div class="ram-stats">
          <span><span class="ram-stat-label">heap</span><span class="ram-stat-value" id="ramHeap">—</span></span>
          <span><span class="ram-stat-label">rss</span><span class="ram-stat-value" id="ramRss">—</span></span>
          <span><span class="ram-stat-label">external</span><span class="ram-stat-value" id="ramExt">—</span></span>
        </div>
        <svg class="ram-chart" id="ramChart" viewBox="0 0 600 60" preserveAspectRatio="none"></svg>
      </div>
    </div>
  </div>

  <script>
    const SKILL_ICONS = { builtin: '⚡', workspace: '✦' };

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
      if (hrs < 1) return \`\${prefix} \${mins}m\`;
      if (days < 1) return \`\${prefix} \${hrs}h\`;
      return \`\${prefix} \${days}d\`;
    }

    function renderUsage(data) {
      const cards = [
        { label: 'Today', d: data.today },
        { label: 'This Month', d: data.month },
        { label: 'All Time', d: data.allTime },
      ];
      document.getElementById('usageGrid').innerHTML = cards.map(({ label, d }) => \`
        <div class="usage-card">
          <div class="usage-card-label">\${label}</div>
          <div class="usage-card-cost">\${fmt(d.totalCost)}</div>
          <div class="usage-card-meta">\${d.totalRequests} requests &middot; \${(d.totalInputTokens + d.totalOutputTokens).toLocaleString()} tokens</div>
        </div>
      \`).join('');
    }

    function renderSkills(data) {
      const list = document.getElementById('skillsList');
      document.getElementById('skillsBadge').textContent = data.skills.length;
      if (!data.skills.length) {
        list.innerHTML = '<li class="empty">No skills installed</li>';
        return;
      }
      list.innerHTML = data.skills.map(s => \`
        <li class="skill-row">
          <div class="skill-icon">\${SKILL_ICONS[s.source] ?? '◆'}</div>
          <div class="skill-body">
            <div class="skill-name">\${s.name}</div>
            <div class="skill-desc">\${s.description}</div>
          </div>
          <span class="skill-source source-\${s.source}">\${s.source}</span>
        </li>
      \`).join('');
    }

    function ago(isoStr) {
      if (!isoStr) return '—';
      const diff = Date.now() - new Date(isoStr).getTime();
      const mins = Math.floor(diff / 60000);
      const hrs = Math.floor(diff / 3600000);
      if (mins < 1) return 'just now';
      if (hrs < 1) return \`\${mins}m ago\`;
      return \`\${hrs}h ago\`;
    }

    const SPAWN_STATUS = { done: '✓', error: '✗', timeout: '⏱' };
    const SPAWN_COLOR = { done: 'var(--green)', error: 'var(--red)', timeout: 'var(--yellow)' };

    async function killAgent(sessionKey) {
      await fetch('/api/spawns?session=' + encodeURIComponent(sessionKey), { method: 'DELETE' });
      refresh();
    }

    function renderSpawns(data) {
      const list = document.getElementById('spawnsList');
      document.getElementById('spawnsBadge').textContent = data.spawns.length;
      if (!data.spawns.length) {
        list.innerHTML = '<li class="empty">No sub-agents spawned yet</li>';
        return;
      }
      list.innerHTML = data.spawns.slice(0, 20).map(s => \`
        <li class="spawn-row">
          <span class="spawn-status" style="color:\${SPAWN_COLOR[s.status] ?? 'var(--muted)'}">\${SPAWN_STATUS[s.status] ?? '·'}</span>
          <span class="spawn-name">\${s.name}</span>
          <span class="spawn-tools">\${s.toolsUsed.join(', ') || '—'}</span>
          <span class="spawn-meta">\${s.cost > 0 ? '$' + s.cost.toFixed(4) : ''} \${ago(s.startedAt)}</span>
          \${s.status === 'running' ? \`<button class="kill-btn" onclick="killAgent('\${s.sessionKey}')">kill</button>\` : ''}
        </li>
      \`).join('');
    }

    function renderMemory(data) {
      const samples = data.samples ?? [];
      if (!samples.length) return;
      const latest = samples[samples.length - 1];
      document.getElementById('ramHeap').textContent = latest.heapMB + ' MB';
      document.getElementById('ramRss').textContent = latest.rssMB + ' MB';
      document.getElementById('ramExt').textContent = latest.externalMB + ' MB';
      document.getElementById('ramBadge').textContent = latest.rssMB + ' MB RSS';

      // SVG sparkline for heap
      const W = 600; const H = 60; const PAD = 4;
      const vals = samples.map(s => s.heapMB);
      const min = Math.min(...vals); const max = Math.max(...vals) || 1;
      const pts = vals.map((v, i) => {
        const x = PAD + (i / Math.max(vals.length - 1, 1)) * (W - PAD * 2);
        const y = H - PAD - ((v - min) / (max - min || 1)) * (H - PAD * 2);
        return \`\${x.toFixed(1)},\${y.toFixed(1)}\`;
      }).join(' ');
      document.getElementById('ramChart').innerHTML = \`
        <polyline points="\${pts}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
        <text x="\${PAD + 2}" y="\${H - PAD - 2}" fill="var(--muted)" font-size="9" font-family="monospace">\${min.toFixed(0)} MB</text>
        <text x="\${W - PAD - 30}" y="12" fill="var(--muted)" font-size="9" font-family="monospace">\${max.toFixed(0)} MB</text>
      \`;
    }

    function renderTasks(data) {
      const list = document.getElementById('tasksList');
      document.getElementById('tasksBadge').textContent = data.tasks.length;
      if (!data.tasks.length) {
        list.innerHTML = '<li class="empty">No scheduled tasks</li>';
        return;
      }
      list.innerHTML = data.tasks.map(t => \`
        <li class="task-row">
          <span class="task-type type-\${t.type}">\${t.type}</span>
          <span class="task-desc">\${t.description}</span>
          <span class="task-time">\${relTime(t.nextRunAt)}</span>
        </li>
      \`).join('');
    }

    async function refresh() {
      try {
        const [usage, skills, tasks, spawns, memory] = await Promise.all([
          fetch('/api/usage').then(r => r.json()),
          fetch('/api/skills').then(r => r.json()),
          fetch('/api/tasks').then(r => r.json()),
          fetch('/api/spawns').then(r => r.json()),
          fetch('/api/memory').then(r => r.json()),
        ]);
        renderUsage(usage);
        renderSkills(skills);
        renderTasks(tasks);
        renderSpawns(spawns);
        renderMemory(memory);
        const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        document.getElementById('refreshInfo').textContent = 'updated ' + now;
        document.getElementById('statusDot').style.background = '#34d399';
        document.getElementById('statusDot').style.boxShadow = '0 0 8px #34d399';
      } catch (e) {
        document.getElementById('refreshInfo').textContent = 'offline';
        document.getElementById('statusDot').style.background = '#f87171';
        document.getElementById('statusDot').style.boxShadow = '0 0 8px #f87171';
      }
    }

    refresh();
    setInterval(refresh, 30000);
  </script>
</body>
</html>`;
}
