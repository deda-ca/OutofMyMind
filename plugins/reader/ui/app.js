// The Read aloud tab (docs/reader.md): an editable page (paste or type; Markdown
// is shown formatted), read aloud sentence by sentence, with the sentence and
// the word being read highlighted. Click a word, or select some text, to read
// from there. Speech comes through the bridge from the plugin (audio.cpp).
//
// Audio is fetched a couple of sentences ahead and kept, so going back is
// instant. The word being read is estimated: each sentence's audio length
// spread over its words by length, with more time at commas and full stops.

const $ = (id) => document.getElementById(id)
const page = $('text')

// ------------------------------------------------------------------ state

const state = {
  voice: '',
  rate: 1,
  voices: [],
  jarvisVoice: '',
  status: 'idle', // idle | loading | playing | paused
  s: 0,
  w: 0,
  total: 0,
}
/** The words of each sentence, as spoken, and their elements (to highlight). */
let segments = []
let words = []
const AHEAD = 2
const RATES = [0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75]
/** Text sizes, as a multiple of the normal one. */
const ZOOMS = [0.85, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.4, 2.8]
let zoom = 1

function showError(text) {
  $('error').textContent = text || ''
  $('error').hidden = !text
}

// ------------------------------------------------------------------ the page: words and sentences

const BLOCK = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,dt,dd,figcaption,div'
const ABBREVIATION = /^(mr|mrs|ms|dr|prof|st|vs|etc|e\.g|i\.e|no|fig|approx|inc|ltd|jr|sr)\.$/i
const ENDS_SENTENCE = /[.!?…]["'”’)\]]*$/
/** A sentence longer than this is split at its next comma, so each piece is quick to synthesise. */
const LONG = 220
/** After typing stops this long, the words are split into sentences again. */
const SETTLE = 400

const toHtml = (markdown) => DOMPurify.sanitize(marked.parse(markdown, { async: false, gfm: true }))
let empty = true

function setEmpty() {
  empty = !page.textContent.trim() && !page.querySelector('img')
  page.classList.toggle('empty', empty)
  $('clear').hidden = empty
  controls()
}

/** Loads Markdown into the page (or empties it). */
function load(markdown) {
  stop()
  page.innerHTML = markdown.trim() ? toHtml(markdown) : ''
  state.s = 0
  state.w = 0
  segment()
}

/** Where the caret is, as characters into the page (survives re-wrapping the words). */
function caret() {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount || !sel.isCollapsed || !page.contains(sel.focusNode)) return null
  const range = document.createRange()
  range.selectNodeContents(page)
  range.setEnd(sel.focusNode, sel.focusOffset)
  return range.toString().length
}

function placeCaret(at) {
  const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT)
  let left = at
  while (walker.nextNode()) {
    const node = walker.currentNode
    const len = node.nodeValue?.length ?? 0
    if (left <= len) {
      window.getSelection()?.collapse(node, left)
      return
    }
    left -= len
  }
}

/** Every word in its own span (code blocks aren't read), then words grouped into sentences. */
function segment() {
  const at = caret()
  for (const el of page.querySelectorAll('span.rw')) el.replaceWith(...el.childNodes)
  page.normalize()
  setEmpty()
  const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('pre,script,style') || !n.nodeValue?.trim() ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  const nodes = []
  while (walker.nextNode()) nodes.push(walker.currentNode)
  const all = []
  for (const node of nodes) {
    const block = node.parentElement?.closest(BLOCK) ?? page
    const frag = document.createDocumentFragment()
    let last = null
    for (const token of node.nodeValue.split(/(\s+)/)) {
      if (!token) continue
      if (/^\s+$/.test(token)) {
        // The space after a word goes in its span, so a highlighted sentence is one band, not patches.
        if (last) last.append(token)
        else frag.append(token)
        continue
      }
      const el = document.createElement('span')
      el.className = 'rw'
      el.textContent = token
      frag.append(el)
      last = el
      all.push({ el, block })
    }
    node.replaceWith(frag)
  }
  const next = []
  words = []
  let cur = []
  let chars = 0
  let block = null
  const flush = () => {
    if (!cur.length) return
    words.push(cur)
    next.push(cur.map((el) => el.textContent.trim()))
    cur = []
    chars = 0
  }
  for (const { el, block: b } of all) {
    if (cur.length && b !== block) flush()
    block = b
    el.dataset.s = String(words.length)
    el.dataset.w = String(cur.length)
    cur.push(el)
    const t = el.textContent.trim()
    chars += t.length + 1
    if ((ENDS_SENTENCE.test(t) && !ABBREVIATION.test(t) && !/^[A-Z]\.$/.test(t)) || (chars > LONG && /[,;:—–]$/.test(t))) flush()
  }
  flush()
  if (at !== null) placeCaret(at)
  dirty = false
  setSegments(next)
  highlight()
}

let dirty = false
let settle = 0

page.addEventListener('input', () => {
  dirty = true
  setEmpty()
  clearTimeout(settle)
  settle = setTimeout(segment, SETTLE)
})

// Pasted text is Markdown (or plain): shown formatted.
page.addEventListener('paste', (event) => {
  const t = event.clipboardData?.getData('text/plain')
  if (!t) return
  event.preventDefault()
  document.execCommand('insertHTML', false, toHtml(t))
  page.dispatchEvent(new Event('input'))
})

/** Settles the words now, if the page was edited (before playing or moving). */
function settled() {
  if (!dirty) return
  clearTimeout(settle)
  segment()
}

let marked_ = []
function highlight() {
  for (const el of marked_) el.classList.remove('rs', 'rs-active', 'rw-now', 'rw-start')
  marked_ = []
  const sentence = words[state.s]
  $('position').textContent = state.total && !empty ? `Sentence ${Math.min(state.s + 1, state.total)} of ${state.total}` : ''
  if (!sentence) return
  const active = state.status === 'playing' || state.status === 'loading'
  for (const el of sentence) {
    el.classList.add('rs')
    if (active) el.classList.add('rs-active')
    marked_.push(el)
  }
  const word = sentence[Math.min(state.w, sentence.length - 1)]
  if (word) {
    word.classList.add(active ? 'rw-now' : 'rw-start')
    if (active) keepInView(word)
  }
}

function keepInView(el) {
  const box = page.parentElement
  const r = el.getBoundingClientRect()
  const b = box.getBoundingClientRect()
  if (r.top < b.top + 24 || r.bottom > b.bottom - 24) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

const at = (el) => ({ s: Number(el.dataset.s), w: Number(el.dataset.w) })

// A click on a word: read from there (now, if reading; otherwise when play is pressed).
page.addEventListener('click', (event) => {
  if (!window.getSelection()?.isCollapsed) return
  settled()
  const el = event.target.closest('.rw')
  if (el?.isConnected && el.dataset.s) seek(at(el))
})

// Text selected: read from its first word.
function onSelect() {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !page.contains(sel.anchorNode)) return
  const range = sel.getRangeAt(0)
  const first = [...page.querySelectorAll('.rw')].find((el) => range.intersectsNode(el))
  if (first?.dataset.s) seek(at(first))
}
page.addEventListener('mouseup', onSelect)
page.addEventListener('keyup', onSelect)

// ------------------------------------------------------------------ playback

const audio = new Audio()
audio.preservesPitch = true
const clips = new Map()
let generation = 0
let frame = 0
let playing = null

function setSegments(next) {
  stop()
  for (const p of clips.values()) void p.then((u) => URL.revokeObjectURL(u)).catch(() => {})
  clips.clear()
  segments = next
  state.total = next.length
  if (state.s >= next.length) {
    state.s = 0
    state.w = 0
  }
}

const key = (s, from) => `${state.voice}|${s}|${from}`

/** One sentence (from a word) as audio: a blob URL, fetched once. */
function clip(s, from) {
  const k = key(s, from)
  let p = clips.get(k)
  if (!p) {
    const text = segments[s].slice(from).join(' ').slice(0, 1000)
    p = jarvis.call('tab_speak', { text, voice: state.voice || undefined }).then((r) => {
      if (r.isError) throw new Error(r.text)
      const bytes = Uint8Array.from(atob(JSON.parse(r.text).wav), (c) => c.charCodeAt(0))
      return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
    })
    p.catch(() => clips.delete(k))
    clips.set(k, p)
  }
  return p
}

function prefetch(s) {
  for (let i = s + 1; i <= s + AHEAD && i < segments.length; i++) void clip(i, 0).catch(() => {})
}

function setStatus(s) {
  state.status = s
  controls()
  highlight()
  // The tab's button: a gently pulsing speaker while reading, a pause sign while paused.
  jarvis.setStatus(s === 'playing' || s === 'loading' ? { icon: '🔊', animate: true, title: 'Reading aloud' } : s === 'paused' ? { icon: '⏸', title: 'Paused' } : null)
}

async function play(from = { s: state.s, w: state.w }) {
  if (!segments.length) return
  const mine = ++generation
  audio.pause()
  cancelAnimationFrame(frame)
  showError('')
  state.s = from.s
  state.w = from.w
  setStatus('loading')
  try {
    const url = await clip(from.s, from.w)
    if (mine !== generation) return
    prefetch(from.s)
    playing = { s: from.s, from: from.w }
    audio.src = url
    audio.playbackRate = state.rate
    await audio.play()
    if (mine !== generation) return
    setStatus('playing')
    track()
  } catch (err) {
    if (mine !== generation) return
    setStatus('paused')
    showError(`Couldn't read this aloud: ${err.message}`)
  }
}

function pause() {
  if (state.status !== 'playing') return
  audio.pause()
  cancelAnimationFrame(frame)
  setStatus('paused')
}

function resume() {
  if (state.status !== 'paused') return
  if (playing && playing.s === state.s && audio.src && !audio.ended && audio.currentTime > 0) {
    void audio.play().then(() => {
      setStatus('playing')
      track()
    })
  } else void play()
}

function stop() {
  generation++
  audio.pause()
  cancelAnimationFrame(frame)
  playing = null
  state.w = 0
  if (state.status !== 'idle') setStatus('idle')
}

function seek(to) {
  if (state.status === 'playing' || state.status === 'loading') return void play(to)
  generation++
  audio.pause()
  playing = null
  state.s = to.s
  state.w = to.w
  setStatus(state.status === 'paused' ? 'idle' : state.status)
}

function step(delta) {
  seek({ s: Math.max(0, Math.min(segments.length - 1, state.s + delta)), w: 0 })
}

audio.addEventListener('ended', () => {
  cancelAnimationFrame(frame)
  const next = (playing?.s ?? state.s) + 1
  if (next < segments.length) void play({ s: next, w: 0 })
  else {
    playing = null
    state.s = 0
    state.w = 0
    setStatus('idle')
  }
})

/** Follows the word being read: the clip's time spread over its words, by length (a pause at punctuation). */
function track() {
  cancelAnimationFrame(frame)
  const tick = () => {
    if (!playing || state.status !== 'playing') return
    const ws = segments[playing.s].slice(playing.from)
    const weights = ws.map((w) => w.length + 1 + (/[.!?…]["'”’)]*$/.test(w) ? 5 : /[,;:—–]$/.test(w) ? 3 : 0))
    const total = weights.reduce((a, b) => a + b, 0)
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      let t = (audio.currentTime / audio.duration) * total
      let i = 0
      while (i < weights.length - 1 && t > weights[i]) t -= weights[i++]
      if (state.w !== playing.from + i) {
        state.w = playing.from + i
        highlight()
      }
    }
    frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
}

// ------------------------------------------------------------------ controls

function controls() {
  const busy = state.status === 'playing' || state.status === 'loading'
  $('play').textContent = state.status === 'loading' ? '… Loading' : busy ? '⏸ Pause' : '▶ Play'
  $('play').disabled = empty
  $('prev').disabled = empty || state.s === 0
  $('next').disabled = empty || state.s >= state.total - 1
  $('stop').disabled = state.status === 'idle'
}

$('play').addEventListener('click', () => {
  settled()
  if (state.status === 'playing' || state.status === 'loading') pause()
  else if (state.status === 'paused') resume()
  else void play()
})
$('stop').addEventListener('click', stop)
$('prev').addEventListener('click', () => step(-1))
$('next').addEventListener('click', () => step(1))
$('clear').addEventListener('click', () => {
  $('title').textContent = 'Read aloud'
  load('')
  page.focus()
})

const remember = () => void jarvis.call('tab_prefs', { voice: state.voice || undefined, rate: state.rate, zoom })

/** The text size: steps up or down (A− / A+, Ctrl − / Ctrl +), remembered. */
function setZoom(next, save = true) {
  zoom = ZOOMS.reduce((a, b) => (Math.abs(b - next) < Math.abs(a - next) ? b : a))
  page.style.setProperty('--zoom', String(zoom))
  $('smaller').disabled = zoom <= ZOOMS[0]
  $('bigger').disabled = zoom >= ZOOMS.at(-1)
  // Keep the sentence being read in view after the text reflows.
  const word = page.querySelector('.rw-now, .rw-start')
  if (word) word.scrollIntoView({ block: 'center' })
  if (save) remember()
}
const zoomStep = (d) => setZoom(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + d))])
$('smaller').addEventListener('click', () => zoomStep(-1))
$('bigger').addEventListener('click', () => zoomStep(1))
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return
  if (e.key === '+' || e.key === '=') zoomStep(1)
  else if (e.key === '-' || e.key === '_') zoomStep(-1)
  else if (e.key === '0') setZoom(1)
  else return
  e.preventDefault()
})
$('voice').addEventListener('change', (e) => {
  state.voice = e.target.value
  remember()
})
$('rate').addEventListener('change', (e) => {
  state.rate = Number(e.target.value)
  audio.playbackRate = state.rate
  remember()
})

async function loadVoices() {
  const v = await jarvis.json('tab_voices').catch(() => null)
  if (!v) return
  state.voices = v.voices
  state.jarvisVoice = v.jarvis
  state.voice = v.voice && v.voices.includes(v.voice) ? v.voice : (v.voices.find((x) => x !== v.jarvis) ?? v.voices[0] ?? '')
  state.rate = RATES.includes(v.rate) ? v.rate : 1
  setZoom(typeof v.zoom === 'number' ? v.zoom : 1, false)
  $('voice').replaceChildren(...v.voices.map((x) => new Option(`${x}${x === v.jarvis ? ' (Jarvis)' : ''}`, x, false, x === state.voice)))
  $('rate').replaceChildren(...RATES.map((r) => new Option(`${r}×`, String(r), false, r === state.rate)))
  $('only-jarvis').hidden = !(v.voices.length > 0 && v.voices.every((x) => x === v.jarvis))
}

/** Text Jarvis handed over (read_aloud): onto the page, ready to play. */
async function takeHandedOver() {
  const p = await jarvis.json('tab_take').catch(() => null)
  if (!p) return
  $('title').textContent = p.title || 'Read aloud'
  load(p.text)
}

// Jarvis talking pauses the reading; it carries on when Jarvis is done (the host says when).
let pausedForJarvis = false
jarvis.onHost((m) => {
  if (m.event === 'assistant-speaking' && state.status === 'playing') {
    pause()
    pausedForJarvis = true
  } else if (m.event === 'assistant-quiet' && pausedForJarvis) {
    pausedForJarvis = false
    resume()
  }
})
jarvis.onRefresh(() => void takeHandedOver())

// Enter makes a new paragraph, not a <div>.
document.execCommand('defaultParagraphSeparator', false, 'p')
controls()
void loadVoices().then(takeHandedOver)
