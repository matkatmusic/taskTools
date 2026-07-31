const KIND = { det: 'deterministic', int: 'interpretive', agent: 'agent spawn' }
const COST = {
  fast: 'fast — script or fixed text',
  med: 'medium — one model turn',
  slow: 'slow — unbounded reads or an agent',
  xslow: 'very slow — agent loop or human gate',
}

const INDEX = {}
for (const [id, s] of Object.entries(GRAPH.skills)) {
  INDEX[id] = Object.assign({ type: 'skill', id }, s)
  for (const st of s.steps) INDEX[st.id] = Object.assign({ type: 'step', skill: id, file: s.file }, st)
}
for (const d of GRAPH.data) INDEX[d.id] = Object.assign({ type: 'data' }, d)
for (const h of GRAPH.hooks) INDEX[h.id] = Object.assign({ type: 'hook' }, h)
for (const e of GRAPH.external) INDEX[e.id] = Object.assign({ type: 'external' }, e)

const nid = (s) => 'n_' + s.replace(/[^a-zA-Z0-9]/g, '_')
const txt = (s) => String(s).replace(/["|{}[\]<>]/g, '')
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const CLASSDEFS = [
  'classDef skill fill:#1f2937,stroke:#58a6ff,color:#e6e8ee',
  'classDef det fill:#132a1a,stroke:#3fb950,color:#e6e8ee',
  'classDef int fill:#2b1c0d,stroke:#f0883e,color:#e6e8ee',
  'classDef agent fill:#221533,stroke:#a371f7,color:#e6e8ee',
  'classDef data fill:#0d1f33,stroke:#58a6ff,color:#c9d1d9',
  'classDef hook fill:#1a1d26,stroke:#8b949e,color:#9aa2b5',
  'classDef ext fill:#1a1d26,stroke:#484f58,color:#9aa2b5',
  'classDef slowline stroke-dasharray: 6 4',
  'classDef hotline color:#ff7b72',
]

function overviewDef() {
  const L = ['flowchart LR']
  const slow = []
  for (const [id, s] of Object.entries(GRAPH.skills)) {
    const n = s.steps.filter((x) => x.kind === 'int').length
    L.push(`  ${nid(id)}["${txt(s.title)}<br/><small>${s.steps.length} steps · ${n} interpretive</small>"]:::skill`)
    if (s.steps.some((x) => x.hot)) slow.push(nid(id))
  }
  for (const d of GRAPH.data) L.push(`  ${nid(d.id)}[("${txt(d.label)}")]:::data`)
  for (const h of GRAPH.hooks) L.push(`  ${nid(h.id)}[/"${txt(h.label)}"/]:::hook`)
  for (const e of GRAPH.external) L.push(`  ${nid(e.id)}(["${txt(e.label)}"]):::ext`)
  for (const [a, b, label] of GRAPH.edges) {
    L.push(label ? `  ${nid(a)} -->|${txt(label)}| ${nid(b)}` : `  ${nid(a)} --> ${nid(b)}`)
  }
  if (slow.length) L.push(`  class ${slow.join(',')} hotline`)
  L.push(...CLASSDEFS.map((c) => '  ' + c))
  for (const id of Object.keys(INDEX)) {
    if (INDEX[id].type !== 'step') L.push(`  click ${nid(id)} call sel("${id}")`)
  }
  return L.join('\n')
}

function skillDef(skillId) {
  const s = GRAPH.skills[skillId]
  const L = ['flowchart TB']
  const slow = []
  const hot = []
  s.steps.forEach((st, i) => {
    const tag = st.kind === 'agent' ? ' ⟳' : ''
    L.push(`  ${nid(st.id)}["${i + 1}. ${txt(st.label)}${tag}<br/><small>${txt(st.file || s.file)}:${txt(st.lines)}</small>"]:::${st.kind}`)
    if (st.cost === 'slow' || st.cost === 'xslow') slow.push(nid(st.id))
    if (st.hot) hot.push(nid(st.id))
    if (i) {
      const prev = s.steps[i - 1]
      L.push(st.edge ? `  ${nid(prev.id)} -->|${txt(st.edge)}| ${nid(st.id)}` : `  ${nid(prev.id)} --> ${nid(st.id)}`)
    }
  })
  if (slow.length) L.push(`  class ${slow.join(',')} slowline`)
  if (hot.length) L.push(`  class ${hot.join(',')} hotline`)
  L.push(...CLASSDEFS.map((c) => '  ' + c))
  s.steps.forEach((st) => L.push(`  click ${nid(st.id)} call sel("${st.id}")`))
  return L.join('\n')
}

function panel(n) {
  const bits = []
  bits.push(`<h2>${esc(n.title || n.label)}</h2>`)
  if (n.type === 'step' || n.type === 'skill') {
    bits.push(`<div class="src">${esc(n.file)}${n.lines ? ':' + esc(n.lines) : ''}</div>`)
  }
  const b = []
  if (n.kind) b.push(`<span class="b ${n.kind}">${KIND[n.kind]}</span>`)
  if (n.cost) b.push(`<span class="b cost">${COST[n.cost] || n.cost}</span>`)
  if (n.hot) b.push('<span class="b hot">hot spot</span>')
  if (b.length) bits.push(`<div class="badges">${b.join('')}</div>`)
  if (n.blurb) bits.push(`<p>${esc(n.blurb)}</p>`)
  if (n.excerpt) bits.push(`<h3>source</h3><pre>${esc(n.excerpt)}</pre>`)
  if (n.why) bits.push(`<h3>why it is that</h3><p>${esc(n.why)}</p>`)
  if (n.rewrite) bits.push(`<h3>make it deterministic</h3><p>${esc(n.rewrite)}</p>`)
  if (n.type === 'skill') bits.push(`<h3>steps</h3><p>${n.steps.length} — ${n.steps.filter((s) => s.kind === 'det').length} deterministic, ${n.steps.filter((s) => s.kind === 'int').length} interpretive, ${n.steps.filter((s) => s.kind === 'agent').length} agent spawns.</p>`)
  document.getElementById('panel').innerHTML = bits.join('')
}

let view = null
let seq = 0

async function draw(def) {
  const { svg, bindFunctions } = await mermaid.render('m' + ++seq, def)
  const stage = document.getElementById('stage')
  stage.innerHTML = svg
  if (bindFunctions) bindFunctions(stage)
}

function crumb() {
  const c = document.getElementById('crumb')
  if (!view) return (c.innerHTML = '')
  const back = view === 'workflow' ? 'tackle-tasks' : ''
  c.innerHTML = `<button onclick="go('')">← all pipelines</button>` +
    (back ? ` <button onclick="go('${back}')">← ${back}</button>` : '')
}

async function go(skillId) {
  view = skillId || null
  crumb()
  await draw(view ? skillDef(view) : overviewDef())
  panel(view ? INDEX[view] : { title: 'taskTools', blurb: 'Every pipeline the plugin offers. Click a skill to open its steps; click a step for its source, its determinism verdict, and — where it is interpretive — a concrete way to make it a script. Costs are structural estimates read off the code, not measurements: script call = fast, one model turn = medium, agent spawn or unbounded read = slow. Dashed borders are the slow ones, red labels are the hot spots.' })
}

function sel(id) {
  const n = INDEX[id]
  if (!n) return
  if (n.type === 'skill') return go(id)
  if (n.drill) return go(n.drill)
  panel(n)
}
window.sel = sel
window.go = go

mermaid.initialize({
  startOnLoad: false, securityLevel: 'loose', theme: 'dark',
  flowchart: { htmlLabels: true, curve: 'basis', nodeSpacing: 40, rankSpacing: 55 },
})
go('')
