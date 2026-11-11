// The Calendar tab (docs/calendar.md): a week at a time, from the plugin's
// local copy of the CalDAV calendar. Runs in a sandboxed frame; everything
// goes through the bridge to this plugin's tab_* tools, as the owner.

const $ = (id) => document.getElementById(id)
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v
    else if (k === 'value') e.value = v
    else if (k === 'checked') e.checked = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else if (v !== false && v !== undefined && v !== null) e.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)))
  return e
}
const pad = (n) => String(n).padStart(2, '0')
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const time = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** Monday of the week shown. */
let weekStart = monday(new Date())
let open = null
function monday(d) {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7))
  return m
}

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
async function act(tool, args) {
  showError(null)
  const r = await jarvis.call(tool, args)
  if (r.isError) {
    showError(r.text)
    return null
  }
  return r.text
}

async function loadStatus() {
  const s = await call('tab_status')
  const state = s.configured ? { ready: 'up to date', connecting: 'connecting…', failed: `not connected: ${s.detail}` }[s.state] ?? s.state : s.detail
  $('status').textContent = `${s.calendar || ''}${s.calendar ? ' · ' : ''}${state} · reminders ${s.reminderMinutes} min before`
}

async function loadWeek() {
  const end = new Date(weekStart)
  end.setDate(end.getDate() + 7)
  const events = await call('tab_range', { from: weekStart.toISOString(), to: end.toISOString() })
  const days = $('days')
  days.replaceChildren()
  const now = new Date()
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart)
    d.setDate(d.getDate() + i)
    const next = new Date(d)
    next.setDate(next.getDate() + 1)
    const todays = events.filter((e) => new Date(e.start) < next && new Date(e.end) > d)
    days.append(
      el(
        'div',
        { class: `day${localDate(d) === localDate(now) ? ' today' : ''}` },
        el('h3', {}, d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })),
        todays.length
          ? todays.map((e) => {
              const s = new Date(e.start)
              const en = new Date(e.end)
              return el(
                'div',
                { class: `event${open === e.id ? ' active' : ''}${en < now ? ' past' : ''}`, tabindex: '0', onclick: () => edit(e), onkeydown: (k) => k.key === 'Enter' && edit(e) },
                el('span', { class: 'when' }, e.allDay ? 'All day' : `${time(s)}–${time(en)}`),
                el('span', { class: 'what' }, e.summary, e.recurring ? ' ↻' : '', e.location ? el('div', { class: 'where' }, e.location) : null),
              )
            })
          : el('div', { class: 'none' }, 'Nothing'),
      ),
    )
  }
}

function edit(e = null) {
  open = e?.id ?? null
  const start = e ? new Date(e.start) : roundedNow()
  const end = e ? new Date(e.end) : new Date(start.getTime() + 3_600_000)
  const allDay = el('input', { type: 'checkbox', checked: e?.allDay ?? false })
  const title = el('input', { value: e?.summary ?? '', required: true })
  const date = el('input', { type: 'date', value: localDate(start) })
  const from = el('input', { type: 'time', value: localTime(start) })
  const to = el('input', { type: 'time', value: localTime(end) })
  const location = el('input', { value: e?.location ?? '' })
  const notes = el('textarea', { value: e?.description ?? '' })
  const reminder = el('input', { type: 'number', min: '0', max: '10080', value: e?.alarmBefore !== null && e?.alarmBefore !== undefined ? String(Math.round(e.alarmBefore / 60)) : '', placeholder: 'default' })
  const series = el('input', { type: 'checkbox', checked: false })
  const status = el('span', { class: 'muted' })
  const times = el('div', { class: 'two' }, el('label', {}, 'From', from), el('label', {}, 'To', to))
  const sync = () => (times.hidden = allDay.checked)
  allDay.addEventListener('change', sync)
  sync()
  const save = async () => {
    if (!title.value.trim()) return showError('Give it a title.')
    const [y, m, d] = date.value.split('-').map(Number)
    const at = (hm) => {
      const [h, mi] = hm.split(':').map(Number)
      return new Date(y, m - 1, d, h, mi)
    }
    const s = allDay.checked ? new Date(y, m - 1, d) : at(from.value)
    let en = allDay.checked ? new Date(y, m - 1, d + 1) : at(to.value)
    if (en <= s) en = new Date(s.getTime() + 3_600_000)
    const r = await act('tab_save', {
      id: e?.id,
      title: title.value,
      start: s.toISOString(),
      end: en.toISOString(),
      all_day: allDay.checked,
      location: location.value,
      notes: notes.value,
      reminder_minutes: reminder.value === '' ? undefined : Number(reminder.value),
      series: e?.recurring ? series.checked : undefined,
    })
    if (r === null) return
    // "Added:\n- Wed, Nov 11, 6:30 PM… [id]" → one line, without the id.
    status.textContent = r.replace(/\n- /g, ' ').replace(/\s*\[[^\]]+\]$/, '')
    await loadWeek()
  }
  const remove = async () => {
    const r = await act('tab_delete', { id: e.id, series: e.recurring ? series.checked : undefined })
    if (r === null) return
    $('detail').replaceChildren(el('p', { class: 'muted empty' }, r))
    open = null
    await loadWeek()
  }
  $('detail').replaceChildren(
    el('h2', {}, e ? 'Event' : 'New event'),
    el(
      'form',
      { class: 'editor', onsubmit: (x) => (x.preventDefault(), void save()) },
      el('label', {}, 'Title', title),
      el('div', { class: 'two' }, el('label', {}, 'Date', date), el('label', { class: 'check' }, allDay, 'All day')),
      times,
      el('label', {}, 'Place', location),
      el('label', {}, 'Notes', notes),
      el('label', {}, 'Remind (minutes before; empty: the default)', reminder),
      e?.recurring ? el('label', { class: 'check' }, series, 'Every time it repeats (not just this one)') : null,
      el(
        'div',
        { class: 'row' },
        el('button', { type: 'submit', class: 'primary' }, e ? 'Save' : 'Add'),
        e ? el('button', { type: 'button', onclick: () => void remove() }, 'Delete') : null,
        status,
      ),
    ),
  )
  title.focus()
  void loadWeek()
}

function roundedNow() {
  const d = new Date()
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0)
  return d
}

const shift = (days) => {
  weekStart = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + days)
  void loadWeek()
}
$('prev').addEventListener('click', () => shift(-7))
$('next').addEventListener('click', () => shift(7))
$('today').addEventListener('click', () => ((weekStart = monday(new Date())), void loadWeek()))
$('refresh').addEventListener('click', async () => (await call('tab_refresh'), await loadStatus(), await loadWeek()))
$('add').addEventListener('click', () => edit())
jarvis.onRefresh(() => (void loadStatus(), void loadWeek()))
void loadStatus().then(loadWeek)
