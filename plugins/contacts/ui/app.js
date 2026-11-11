// The Contacts tab (docs/contacts.md). Runs in a sandboxed frame; everything
// goes through the bridge to this plugin's tab_* tools, as the owner.

const $ = (id) => document.getElementById(id)
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v
    else if (k === 'value') e.value = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else if (v !== false && v !== undefined && v !== null) e.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)))
  return e
}
const phone = (n) => {
  const m = /^1(\d{3})(\d{3})(\d{4})$/.exec(n)
  return m ? `+1 ${m[1]}-${m[2]}-${m[3]}` : n
}

const state = { view: 'all', tag: '', query: '', open: null }

function showError(err) {
  $('error').textContent = err ? String(err.message ?? err) : ''
  $('error').hidden = !err
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

async function loadStatus() {
  const s = await call('tab_status')
  $('status').textContent = `${s.contacts} contact${s.contacts === 1 ? '' : 's'}${s.suggestions ? ` · ${s.suggestions} suggested from email` : ''}`
  const f = $('filters')
  const btn = (label, on, click) => el('button', { type: 'button', class: on ? 'on' : '', onclick: click }, label)
  const pick = (view, tag = '') => () => {
    state.view = view
    state.tag = tag
    void loadStatus()
    void loadList()
  }
  f.replaceChildren(
    btn('All', state.view === 'all', pick('all')),
    btn(`Suggested${s.suggestions ? ` (${s.suggestions})` : ''}`, state.view === 'suggested', pick('suggested')),
    btn(`Set aside${s.ignored ? ` (${s.ignored})` : ''}`, state.view === 'ignored', pick('ignored')),
    ...s.tags.slice(0, 12).map((t) => btn(`#${t.tag}`, state.view === 'tag' && state.tag === t.tag, pick('tag', t.tag))),
  )
}

async function loadList() {
  const list = $('list')
  if (state.view === 'suggested' || state.view === 'ignored') return loadSuggestions()
  const r = await call('tab_list', { query: state.query || undefined, tag: state.view === 'tag' ? state.tag : undefined })
  list.replaceChildren()
  if (!r.contacts.length) list.append(el('p', { class: 'muted empty' }, state.query ? 'Nobody matches.' : 'No contacts yet: add one, import a .vcf, or accept suggestions from your email.'))
  for (const c of r.contacts) {
    const sub = [c.org, c.emails[0]?.value, c.phones[0] ? phone(c.phones[0].value) : ''].filter(Boolean).join(' · ')
    list.append(el('div', { class: `item${state.open === c.id ? ' active' : ''}`, role: 'listitem', tabindex: '0', onclick: () => edit(c) }, el('div', { class: 'name' }, c.name), el('div', { class: 'sub' }, sub)))
  }
}

// ------------------------------------------------------------------ suggestions

async function loadSuggestions() {
  const list = $('list')
  const ignored = state.view === 'ignored'
  const items = await call('tab_suggestions', { status: ignored ? 'ignored' : 'new' })
  list.replaceChildren()
  if (!items.length) list.append(el('p', { class: 'muted empty' }, ignored ? 'Nothing set aside.' : 'No suggestions: new people who email you show up here.'))
  for (const s of items) {
    list.append(
      el(
        'div',
        { class: 'suggestion' },
        el('div', {}, el('strong', {}, s.name || s.address), s.name ? el('div', { class: 'muted' }, s.address) : null),
        ignored && s.reason ? el('div', { class: 'muted' }, `Set aside: ${s.reason}.`) : null,
        el(
          'div',
          { class: 'row' },
          ignored
            ? el('button', { type: 'button', onclick: async () => (await call('tab_ignore', { address: s.address, ignore: false }), refresh()) }, 'Suggest it')
            : [
                el('button', { type: 'button', class: 'primary', onclick: async () => (await call('tab_accept', { address: s.address, name: s.name || undefined }), refresh()) }, 'Add'),
                el('button', { type: 'button', onclick: () => addTo(s) }, 'Add to someone…'),
                el('button', { type: 'button', onclick: async () => (await call('tab_ignore', { address: s.address }), refresh()) }, 'Ignore'),
              ],
        ),
      ),
    )
  }
}

async function addTo(s) {
  const d = $('detail')
  const results = el('div', { class: 'list' })
  const find = async (q) => {
    const r = await call('tab_list', { query: q || undefined, limit: 30 })
    results.replaceChildren(
      ...r.contacts.map((c) =>
        el('div', { class: 'item', onclick: async () => (await call('tab_accept', { address: s.address, contact_id: c.id }), refresh(), edit(await call('tab_get', { id: c.id }))) }, el('div', { class: 'name' }, c.name), el('div', { class: 'sub' }, c.emails.map((e) => e.value).join(', '))),
      ),
    )
  }
  const input = el('input', { type: 'search', placeholder: 'Who is it?', oninput: (e) => void find(e.target.value) })
  d.replaceChildren(el('h3', {}, `Add ${s.address} to…`), input, results)
  input.focus()
  void find(s.name.split(' ')[0] ?? '')
}

// ------------------------------------------------------------------ one contact

function multi(label, items, placeholder) {
  const box = el('div', { class: 'multi' })
  const rows = []
  const add = (item = { value: '', label: '' }) => {
    const value = el('input', { value: item.label === undefined ? item : item.value, placeholder })
    const tag = el('input', { class: 'label', value: item.label ?? '', placeholder: 'label' })
    const row = el('div', { class: 'row' }, value, tag, el('button', { type: 'button', 'aria-label': 'Remove', onclick: () => (row.remove(), rows.splice(rows.indexOf(entry), 1)) }, '×'))
    const entry = { value, tag }
    rows.push(entry)
    box.insertBefore(row, more)
  }
  const more = el('button', { type: 'button', onclick: () => add() }, `Add ${label.toLowerCase()}`)
  box.append(more)
  for (const i of items) add(i)
  if (!items.length) add()
  return { node: el('label', {}, `${label}s`, box), values: () => rows.map((r) => ({ value: r.value.value.trim(), label: r.tag.value.trim() })).filter((r) => r.value) }
}

function edit(c = { id: '', name: '', org: '', notes: '', birthday: '', tags: [], emails: [], phones: [] }) {
  state.open = c.id || null
  for (const i of document.querySelectorAll('.item')) i.classList.remove('active')
  const d = $('detail')
  const name = el('input', { value: c.name, required: true })
  const org = el('input', { value: c.org, placeholder: 'Company, or what they are (dentist)' })
  const emails = multi('Email', c.emails, 'name@example.com')
  const phones = multi('Phone', c.phones.map((p) => ({ value: phone(p.value), label: p.label })), '613-555-0123')
  const birthday = el('input', { type: 'date', value: c.birthday })
  const tags = el('input', { value: c.tags.join(', '), placeholder: 'family, school' })
  const notes = el('textarea', { value: c.notes })
  const status = el('span', { class: 'muted' })
  const save = async () => {
    if (!name.value.trim()) return showError('A contact needs a name.')
    const saved = await call('tab_save', {
      id: c.id || undefined,
      name: name.value,
      org: org.value,
      notes: notes.value,
      birthday: birthday.value,
      tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
      emails: emails.values(),
      phones: phones.values(),
    })
    c.id = saved.id
    status.textContent = 'Saved.'
    void refresh()
  }
  d.replaceChildren(
    el('h2', {}, c.id ? c.name : 'New contact'),
    el(
      'form',
      { class: 'editor', onsubmit: (e) => (e.preventDefault(), void save()) },
      el('label', {}, 'Name', name),
      el('label', {}, 'Organisation', org),
      emails.node,
      phones.node,
      el('label', {}, 'Birthday', birthday),
      el('label', {}, 'Tags', tags),
      el('label', {}, 'Notes', notes),
      el(
        'div',
        { class: 'row' },
        el('button', { type: 'submit', class: 'primary' }, 'Save'),
        c.id ? el('button', { type: 'button', onclick: () => jarvis.ask(`About my contact ${c.name}: `) }, 'Ask Jarvis') : null,
        c.id ? el('button', { type: 'button', onclick: async () => (await call('tab_delete', { id: c.id }), d.replaceChildren(el('p', { class: 'muted empty' }, 'Deleted.')), refresh()) }, 'Delete') : null,
        status,
      ),
    ),
  )
  ;(c.id ? org : name).focus()
}

// ------------------------------------------------------------------ import, export, start

async function refresh() {
  await loadStatus()
  await loadList()
}

$('import').addEventListener('change', async (e) => {
  const file = e.target.files?.[0]
  if (!file) return
  const r = await call('tab_import', { vcf: await file.text() })
  $('status').textContent = `Imported: ${r.added} new, ${r.merged} merged into people already here.`
  e.target.value = ''
  void loadList()
})
$('export').addEventListener('click', async () => {
  const r = await call('tab_export')
  showError(null)
  $('status').textContent = `Exported ${r.count} to ${r.file} in the workspace.`
})
$('add').addEventListener('click', () => edit())
$('search').addEventListener('submit', (e) => {
  e.preventDefault()
  state.query = $('query').value.trim()
  if (state.view !== 'all' && state.view !== 'tag') state.view = 'all'
  void refresh()
})
jarvis.onRefresh(() => void refresh())
void refresh()
