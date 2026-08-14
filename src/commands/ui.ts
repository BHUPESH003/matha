import * as path from 'path'
import { resolveBrainDir, BrainNotFoundError } from '@/core/resolve.js'
import { Engine } from '@/core/engine.js'
import { splitComponent } from '@/core/schema.js'
import { changedSince } from '@/retrieve/match.js'
import { writeTextAtomic } from '@/storage/writer.js'

/**
 * `matha ui` — single self-contained HTML report at .matha/report.html
 * (§5.4): filterable records table (doubles as the review-triage surface),
 * stability blocks, co-change hotspots. Inline CSS/JS, no server, no deps.
 *
 * ponytail: stability is proportional bars, not a true squarified treemap,
 * and co-change is a table, not a force graph — upgrade both only if a
 * real brain makes the simple views unreadable.
 */

interface UiDeps {
  log?: (msg: string) => void
}

export interface UiResult {
  exitCode: 0 | 1
  message?: string
  outPath?: string
}

interface UiRecord {
  type: string
  id: string
  component: string
  text: string
  confidence: string
  status: string
  date: string
  needsReview: boolean
  sessionId: string
}

export async function runUi(
  projectRoot: string = process.cwd(),
  deps?: UiDeps,
): Promise<UiResult> {
  const log = deps?.log ?? console.log

  let mathaDir: string
  try {
    mathaDir = (await resolveBrainDir({ explicitRoot: projectRoot })).mathaDir
  } catch (err) {
    if (err instanceof BrainNotFoundError) {
      const message = 'MATHA is not initialised. Run `matha init` first.'
      log(message)
      return { exitCode: 1, message }
    }
    throw err
  }

  const engine = new Engine(mathaDir)
  const brain = await engine.loadBrain()

  const records: UiRecord[] = []
  for (const d of brain.decisions) {
    const stale =
      d.status === 'active' &&
      changedSince(
        splitComponent(d.component).paths,
        d.last_confirmed ?? d.timestamp,
        brain.fileLastChanged,
      )
    records.push({
      type: 'decision',
      id: d.id,
      component: d.component,
      text: `assumed: ${d.previous_assumption} → actually: ${d.correction}${d.retired_reason ? ` (retired: ${d.retired_reason})` : ''}`,
      confidence: d.confidence,
      status: d.status + (stale ? ' · possibly stale' : ''),
      date: d.timestamp.slice(0, 10),
      needsReview: d.status === 'active' && (d.confidence !== 'confirmed' || stale),
      sessionId: d.session_id,
    })
  }
  for (const z of brain.dangerZones) {
    const status = z.status ?? 'active'
    records.push({
      type: 'danger',
      id: z.id,
      component: z.component,
      text: z.description,
      confidence: z.confidence ?? 'probable',
      status,
      date: '',
      needsReview: status === 'active' && z.confidence !== 'confirmed',
      sessionId: '',
    })
  }
  for (const b of brain.boundaries ?? []) {
    records.push({
      type: 'boundary',
      id: b.id,
      component: b.component,
      text: `${b.rule} (by ${b.declaredBy})`,
      confidence: 'confirmed',
      status: b.status ?? 'active',
      date: b.created.slice(0, 10),
      needsReview: false,
      sessionId: '',
    })
  }
  for (const c of brain.contracts) {
    const violated = c.assertions.filter((a) => a.violation_count > 0)
    records.push({
      type: 'contract',
      id: `contract:${c.component}`,
      component: c.component,
      text:
        c.assertions.map((a) => a.description).join(' · ') +
        (violated.length > 0 ? ` — ⚠ ${violated.length} assertion(s) violated` : ''),
      confidence: 'confirmed',
      status: 'active',
      date: c.last_updated.slice(0, 10),
      needsReview: violated.length > 0,
      sessionId: '',
    })
  }

  const stability = [...brain.stability].sort((a, b) => b.changeCount - a.changeCount)
  const coChanges = [...brain.coChanges]
    .sort((a, b) => b.coChangeCount - a.coChangeCount)
    .slice(0, 25)

  const data = { records, stability, coChanges }
  const html = renderHtml(JSON.stringify(data).replace(/</g, '\\u003c'))

  const outPath = path.join(mathaDir, 'report.html')
  await writeTextAtomic(outPath, html)
  log(`✓ Brain report written to ${outPath} — open it in a browser.`)
  log(`  ${records.filter((r) => r.needsReview).length} record(s) flagged for review (matha review).`)
  return { exitCode: 0, outPath }
}

function renderHtml(dataJson: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>matha — brain report</title>
<style>
  :root { --bg:#0f1115; --panel:#181b22; --text:#d7dae0; --dim:#8b919d; --line:#262b35;
          --critical:#e5534b; --warn:#d4a72c; --ok:#57ab5a; --info:#539bf5; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; background:var(--bg); color:var(--text); padding:24px; }
  h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:15px; margin:28px 0 10px; color:var(--dim); text-transform:uppercase; letter-spacing:.06em; }
  .sub { color:var(--dim); margin-bottom:20px; }
  .filters { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; }
  select, input[type=search] { background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:6px; padding:6px 10px; font:inherit; }
  input[type=search] { flex:1; min-width:180px; }
  label.chk { display:flex; align-items:center; gap:6px; color:var(--dim); }
  table { width:100%; border-collapse:collapse; background:var(--panel); border-radius:8px; overflow:hidden; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.05em; }
  td.comp { font-family:ui-monospace, monospace; font-size:12px; white-space:nowrap; }
  .tag { display:inline-block; padding:1px 7px; border-radius:10px; font-size:11px; font-weight:600; }
  .t-decision { background:#1c3a5e; color:#8ecbff; } .t-danger { background:#4a1f1c; color:#ff9d95; }
  .t-boundary { background:#3d2a4d; color:#d2a8ff; } .t-contract { background:#1f3d2b; color:#7ee2a8; }
  .review { color:var(--warn); font-size:12px; }
  .bar-row { display:flex; align-items:center; gap:10px; margin:3px 0; }
  .bar-label { font-family:ui-monospace, monospace; font-size:12px; width:40%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .bar { height:14px; border-radius:3px; min-width:2px; }
  .s-frozen { background:var(--info); } .s-stable { background:var(--ok); }
  .s-volatile { background:var(--warn); } .s-disposable { background:var(--dim); }
  .legend { color:var(--dim); font-size:12px; margin-bottom:8px; }
  .legend span { margin-right:14px; }
  .dot { display:inline-block; width:9px; height:9px; border-radius:2px; margin-right:4px; vertical-align:baseline; }
  .count { color:var(--dim); font-size:12px; }
</style>
</head>
<body>
<h1>matha — brain report</h1>
<div class="sub">Generated by <code>matha ui</code>. Records flagged <span class="review">⚠ review</span> are resolvable with <code>matha review</code>.</div>

<h2>Records <span id="count" class="count"></span></h2>
<div class="filters">
  <select id="f-type"><option value="">all types</option><option>decision</option><option>danger</option><option>boundary</option><option>contract</option></select>
  <select id="f-status"><option value="">all statuses</option><option>active</option><option>superseded</option><option>retired</option></select>
  <select id="f-conf"><option value="">all confidence</option><option>confirmed</option><option>probable</option><option>uncertain</option></select>
  <label class="chk"><input type="checkbox" id="f-review"> needs review only</label>
  <input type="search" id="f-text" placeholder="search text or path…">
</div>
<table>
  <thead><tr><th>Type</th><th>Component</th><th>Record</th><th>Confidence</th><th>Status</th><th>Date</th><th>Session</th></tr></thead>
  <tbody id="rows"></tbody>
</table>

<h2>Stability (change frequency from git)</h2>
<div class="legend">
  <span><i class="dot s-frozen"></i>frozen</span><span><i class="dot s-stable"></i>stable</span>
  <span><i class="dot s-volatile"></i>volatile</span><span><i class="dot s-disposable"></i>disposable</span>
</div>
<div id="stability"></div>

<h2>Co-change hotspots</h2>
<table>
  <thead><tr><th>File A</th><th>File B</th><th>Co-changes</th></tr></thead>
  <tbody id="cochanges"></tbody>
</table>

<script>
const DATA = ${dataJson};
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function render() {
  const type = document.getElementById('f-type').value;
  const status = document.getElementById('f-status').value;
  const conf = document.getElementById('f-conf').value;
  const review = document.getElementById('f-review').checked;
  const q = document.getElementById('f-text').value.toLowerCase();
  const rows = DATA.records.filter(r =>
    (!type || r.type === type) &&
    (!status || r.status.startsWith(status)) &&
    (!conf || r.confidence === conf) &&
    (!review || r.needsReview) &&
    (!q || (r.component + ' ' + r.text + ' ' + r.id + ' ' + r.sessionId).toLowerCase().includes(q))
  );
  document.getElementById('count').textContent = '(' + rows.length + ' of ' + DATA.records.length + ')';
  document.getElementById('rows').innerHTML = rows.map(r =>
    '<tr><td><span class="tag t-' + r.type + '">' + r.type + '</span>' +
    (r.needsReview ? ' <span class="review" title="unconfirmed or possibly stale">⚠ review</span>' : '') + '</td>' +
    '<td class="comp">' + esc(r.component) + '</td>' +
    '<td>' + esc(r.text) + '</td>' +
    '<td>' + esc(r.confidence) + '</td><td>' + esc(r.status) + '</td><td>' + esc(r.date) + '</td>' +
    '<td class="comp">' + esc(r.sessionId) + '</td></tr>'
  ).join('') || '<tr><td colspan="7" class="count">no records match the filters</td></tr>';
}
document.querySelectorAll('.filters select, .filters input').forEach(el =>
  el.addEventListener(el.type === 'search' ? 'input' : 'change', render));
render();

const maxChanges = Math.max(1, ...DATA.stability.map(s => s.changeCount));
document.getElementById('stability').innerHTML = DATA.stability.slice(0, 40).map(s =>
  '<div class="bar-row"><div class="bar-label" title="' + esc(s.filepath) + '">' + esc(s.filepath) + '</div>' +
  '<div class="bar s-' + esc(s.stability) + '" style="width:' + Math.max(1, 55 * s.changeCount / maxChanges) + '%"' +
  ' title="' + esc(s.stability) + ' — ' + s.changeCount + ' changes"></div>' +
  '<div class="count">' + s.changeCount + '</div></div>'
).join('') || '<div class="count">no stability data — run matha_refresh or commit some history</div>';

document.getElementById('cochanges').innerHTML = DATA.coChanges.map(p =>
  '<tr><td class="comp">' + esc(p.fileA) + '</td><td class="comp">' + esc(p.fileB) + '</td><td>' + p.coChangeCount + '</td></tr>'
).join('') || '<tr><td colspan="3" class="count">no co-change data</td></tr>';
</script>
</body>
</html>
`
}
