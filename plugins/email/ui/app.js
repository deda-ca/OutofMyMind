// The Email tab: the local copy of the owner's email (docs/email.md). Runs in
// a sandboxed frame; everything goes through the bridge (jarvis.json /
// jarvis.call) to this plugin's tab_* tools, as the owner.

const $ = (id) => document.getElementById(id)
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else if (v !== false && v !== undefined && v !== null) e.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)))
  return e
}

const state = { filter: 'all', tag: '', query: '', offset: 0, total: 0, items: [], open: null, view: 'mail' }
const who = (a) => (a ? a.name || a.address : '')
const whoFull = (a) => (a.name ? `${a.name} <${a.address}>` : a.address)
const when = (iso) => {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}

function showError(err) {
  const box = $('error')
  box.textContent = err ? String(err.message ?? err) : ''
  box.hidden = !err
}

async function call(tool, args) {
  try {
    showError(null)
    return await jarvis.json(tool, args)
  } catch (err) {
    showError(err)
    throw err
  }
}

// ------------------------------------------------------------------ status and filters

async function loadStatus() {
  const s = await call('tab_status')
  const state_ = s.configured ? { watching: 'watching', connecting: 'connecting…', failed: `not connected: ${s.detail}`, off: 'off' }[s.state] ?? s.state : s.detail
  $('status').textContent = `${s.address || ''} · ${state_}${s.syncing ? ' · saving recent mail…' : ''} · ${s.messages} saved, ${s.unread} unread`
  renderFilters(s)
}

function renderFilters(s) {
  const f = $('filters')
  f.replaceChildren()
  const btn = (label, on, click) => el('button', { type: 'button', class: on ? 'on' : '', onclick: click }, label)
  const pick = (filter, tag = '') => () => {
    state.filter = filter
    state.tag = tag
    state.offset = 0
    void loadList()
    renderFilters(s)
  }
  f.append(
    btn('All', state.filter === 'all', pick('all')),
    btn(`Unread${s.unread ? ` (${s.unread})` : ''}`, state.filter === 'unread', pick('unread')),
    btn('Sent', state.filter === 'sent', pick('sent')),
    btn(`Drafts${s.drafts ? ` (${s.drafts})` : ''}`, state.filter === 'drafts', pick('drafts')),
    btn('People', state.filter === 'people', pick('people')),
    ...s.tags.slice(0, 12).map((t) => btn(`#${t.tag} (${t.count})`, state.filter === 'tag' && state.tag === t.tag, pick('tag', t.tag))),
  )
}

// ------------------------------------------------------------------ the list

async function loadList(append = false) {
  const list = $('list')
  if (state.filter === 'drafts') return loadDrafts()
  if (state.filter === 'people') return loadPeople()
  const r = await call('tab_list', {
    query: state.query || undefined,
    unread: state.filter === 'unread' || undefined,
    sent: state.filter === 'sent' || undefined,
    tag: state.filter === 'tag' ? state.tag : undefined,
    offset: state.offset,
    limit: 50,
  })
  state.total = r.total
  state.items = append ? [...state.items, ...r.messages] : r.messages
  if (!append) list.replaceChildren()
  if (!state.items.length) list.append(el('p', { class: 'muted empty' }, state.query ? 'Nothing matches.' : 'No email here yet.'))
  for (const m of r.messages) list.append(row(m))
  $('more').hidden = state.items.length >= state.total
}

function row(m) {
  const unread = m.direction === 'in' && !m.seen
  return el(
    'div',
    { class: `item${unread ? ' unread' : ''}${state.open === m.id ? ' active' : ''}`, role: 'listitem', tabindex: '0', 'data-id': m.id, onclick: () => openMessage(m.id), onkeydown: (e) => e.key === 'Enter' && openMessage(m.id) },
    el('div', { class: 'top' }, el('span', { class: 'who' }, m.direction === 'out' ? `To ${m.to.map(who).join(', ')}` : who(m.from)), el('span', { class: 'date' }, when(m.date))),
    el('div', { class: 'subject' }, m.subject || '(no subject)', m.attachments.length ? ' 📎' : ''),
    el('div', { class: 'snippet' }, ...m.tags.map((t) => el('span', { class: 'tag' }, t)), m.snippet),
  )
}

// ------------------------------------------------------------------ reading

async function openMessage(id) {
  state.open = id
  for (const i of document.querySelectorAll('.item')) i.classList.toggle('active', i.dataset.id === id)
  const m = await call('tab_get', { id })
  if (m.direction === 'in' && !m.seen) {
    await call('tab_set_read', { id, read: true })
    m.seen = true
    document.querySelector(`.item[data-id="${CSS.escape(id)}"]`)?.classList.remove('unread')
    void loadStatus()
  }
  renderMessage(m)
}

function renderMessage(m, html = false) {
  const r = $('reader')
  r.replaceChildren()
  // append() would print a null as "null": only the parts there are.
  const parts = [
    el('h2', {}, m.subject || '(no subject)'),
    el('div', { class: 'meta' }, 'From ', whoFull(m.from)),
    el('div', { class: 'meta' }, 'To ', m.to.map(whoFull).join(', ')),
    m.cc.length ? el('div', { class: 'meta' }, 'Cc ', m.cc.map(whoFull).join(', ')) : null,
    el('div', { class: 'meta' }, new Date(m.date).toLocaleString()),
    tagEditor(m),
    m.attachments.length
      ? el('div', { class: 'meta attachments' }, '📎 ', ...m.attachments.map((a) => el('a', { href: '#', onclick: (e) => (e.preventDefault(), jarvis.open(`/api/workspace-file?path=${encodeURIComponent(`email/${a.file}`)}`)) }, `${a.name} (${size(a.size)})`)))
      : null,
    el(
      'div',
      { class: 'row actions' },
      m.direction === 'in' ? el('button', { type: 'button', onclick: () => replyTo(m.id, false) }, 'Reply') : null,
      m.direction === 'in' && m.to.length + m.cc.length > 1 ? el('button', { type: 'button', onclick: () => replyTo(m.id, true) }, 'Reply all') : null,
      m.direction === 'in' ? el('button', { type: 'button', onclick: () => markUnread(m) }, 'Mark unread') : null,
      m.html ? el('button', { type: 'button', onclick: () => renderMessage(m, !html) }, html ? 'Show text' : 'Show formatted') : null,
      el('button', { type: 'button', onclick: () => jarvis.ask(`About the email "${m.subject}" from ${whoFull(m.from)} (id ${m.id}, file email/${m.md}): `) }, 'Ask Jarvis'),
    ),
  ]
  r.append(...parts.filter(Boolean))
  if (html && m.html) {
    // No scripts, no forms; remote images and links stay blocked (the tab's CSP applies here too).
    r.append(el('iframe', { class: 'html-frame', sandbox: '', srcdoc: m.html, title: 'The email, formatted' }))
  } else {
    r.append(el('div', { class: 'body' }, m.text || '(no text)'))
  }
  if (m.direction === 'in') r.append(el('p', { class: 'muted note' }, 'Written by the sender: Jarvis treats it as information, never instructions.'))
}

function tagEditor(m) {
  const wrap = el('div', { class: 'row tags meta' })
  const render = () => {
    wrap.replaceChildren(
      ...m.tags.map((t) => el('span', { class: 'tag' }, t, el('button', { type: 'button', 'aria-label': `Remove ${t}`, onclick: () => save(m.tags.filter((x) => x !== t)) }, '×'))),
      el('input', { placeholder: 'add a tag', 'aria-label': 'Add a tag', onkeydown: (e) => e.key === 'Enter' && e.target.value.trim() && save([...m.tags, e.target.value.trim()]) }),
    )
  }
  const save = async (tags) => {
    const r = await call('tab_set_tags', { id: m.id, tags })
    m.tags = r.tags
    render()
    void loadStatus()
  }
  render()
  return wrap
}

async function markUnread(m) {
  await call('tab_set_read', { id: m.id, read: false })
  document.querySelector(`.item[data-id="${CSS.escape(m.id)}"]`)?.classList.add('unread')
  void loadStatus()
}

const size = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`)

// ------------------------------------------------------------------ drafts and sending

async function replyTo(id, all) {
  const d = await call('tab_reply_draft', { id, all })
  editDraft(d)
}

function editDraft(d = { id: '', to: [], cc: [], subject: '', body: '', replyTo: '' }) {
  const r = $('reader')
  const field = (label, value, attrs = {}) => {
    const input = el(attrs.multiline ? 'textarea' : 'input', { value: attrs.multiline ? undefined : value, ...attrs, multiline: undefined })
    if (attrs.multiline) input.value = value
    return [el('label', {}, label, input), input]
  }
  const [toL, to] = field('To', d.to.map(whoFull).join(', '))
  const [ccL, cc] = field('Cc', d.cc.map(whoFull).join(', '))
  const [subL, subject] = field('Subject', d.subject)
  const [bodyL, body] = field('Text', d.body, { multiline: true })
  const status = el('span', { class: 'muted' })
  const values = () => ({ id: d.id || undefined, to: to.value, cc: cc.value, subject: subject.value, body: body.value, reply_to: d.replyTo || undefined })
  const save = async () => {
    const saved = await call('tab_save_draft', values())
    d.id = saved.id
    status.textContent = 'Saved.'
    return saved
  }
  const send = async (e) => {
    const button = e.target
    if (!to.value.trim() || !subject.value.trim()) return showError('Give who it goes to and a subject.')
    button.disabled = true
    status.textContent = 'Sending…'
    try {
      const saved = await save()
      // Pressing Send here is the owner's yes.
      const result = await jarvis.call('send_draft', { draft: saved.id })
      if (result.isError) throw new Error(result.text)
      status.textContent = result.text
      void loadStatus()
      if (state.filter === 'drafts' || state.filter === 'sent') void loadList()
    } catch (err) {
      showError(err)
      status.textContent = ''
      button.disabled = false
    }
  }
  r.replaceChildren(
    el('h2', {}, d.replyTo ? 'Reply' : d.id ? 'Draft' : 'New email'),
    el(
      'form',
      { class: 'editor', onsubmit: (e) => e.preventDefault() },
      toL,
      ccL,
      subL,
      bodyL,
      d.replyTo ? el('p', { class: 'muted note' }, 'The email you are answering is quoted below your text when it is sent.') : null,
      el(
        'div',
        { class: 'row' },
        el('button', { type: 'button', class: 'primary', onclick: send }, 'Send'),
        el('button', { type: 'button', onclick: () => void save() }, 'Save draft'),
        d.id
          ? el('button', { type: 'button', onclick: async () => (await call('tab_delete_draft', { id: d.id }), r.replaceChildren(el('p', { class: 'muted empty' }, 'Draft deleted.')), void loadStatus(), state.filter === 'drafts' && loadList()) }, 'Delete')
          : null,
        status,
      ),
    ),
  )
  ;(d.to.length ? body : to).focus()
}

async function loadDrafts() {
  const list = $('list')
  const drafts = await call('tab_drafts')
  list.replaceChildren()
  if (!drafts.length) list.append(el('p', { class: 'muted empty' }, 'No drafts. Jarvis saves one when you ask it to write an email for you to look at first.'))
  for (const d of drafts) {
    list.append(
      el(
        'div',
        { class: 'item', role: 'listitem', tabindex: '0', onclick: () => editDraft(d) },
        el('div', { class: 'top' }, el('span', { class: 'who' }, `To ${d.to.map(who).join(', ') || '(nobody yet)'}`), el('span', { class: 'date' }, when(d.updatedAt))),
        el('div', { class: 'subject' }, d.subject || '(no subject)'),
        el('div', { class: 'snippet' }, d.body.slice(0, 120)),
      ),
    )
  }
  $('more').hidden = true
}

async function loadPeople() {
  const list = $('list')
  const people = await call('tab_addresses', { query: state.query || undefined })
  list.replaceChildren(
    el(
      'table',
      { class: 'addresses' },
      el('tr', {}, el('th', {}, 'Who'), el('th', {}, 'Wrote'), el('th', {}, 'Written to')),
      ...people.map((p) =>
        el('tr', {}, el('td', { title: p.address }, p.name ? `${p.name}` : p.address, p.name ? el('div', { class: 'muted' }, p.address) : null), el('td', {}, p.fromCount), el('td', {}, p.toCount)),
      ),
    ),
  )
  if (!people.length) list.append(el('p', { class: 'muted empty' }, 'No addresses yet.'))
  $('more').hidden = true
}

// ------------------------------------------------------------------ start

$('search').addEventListener('submit', (e) => {
  e.preventDefault()
  state.query = $('query').value.trim()
  state.offset = 0
  void loadList()
})
$('more').addEventListener('click', () => {
  state.offset = state.items.length
  void loadList(true)
})
$('compose').addEventListener('click', () => editDraft())
// New mail, a sent email, a change from Jarvis: reload what's shown.
jarvis.onRefresh(() => {
  void loadStatus()
  if (state.filter !== 'drafts' && state.filter !== 'people') {
    state.offset = 0
    void loadList()
  }
})
void loadStatus().then(() => loadList())
