// The bridge between a plugin's tab (a sandboxed frame) and its plugin
// (docs/plugins.md). The page can't call Jarvis's API itself: it asks the
// Jarvis page hosting it, which calls only this plugin's tools as the owner.
//
//   const result = await jarvis.call('search', { query: 'invoice' })   // { text, isError }
//   const data = await jarvis.json('list_messages', { limit: 50 })     // the tool's text, parsed as JSON
//   jarvis.onRefresh(() => load())                                     // the plugin said something changed
//   jarvis.ask('Summarise this email: …')                               // asks Jarvis in the conversation
//   jarvis.setStatus({ icon: '🔊', animate: true, badge: '3' })        // what the tab's button shows (null: clear)
//   jarvis.onHost((m) => …)                                            // the Jarvis page says something
//                                                                      // (m.event: 'assistant-speaking', 'assistant-quiet')
;(() => {
  let next = 1
  const waiting = new Map()
  const refreshers = []
  const hostListeners = []
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || !e.data || typeof e.data !== 'object') return
    const m = e.data
    if (m.jarvis === 'result' && waiting.has(m.id)) {
      const { resolve } = waiting.get(m.id)
      waiting.delete(m.id)
      resolve(m.result)
    } else if (m.jarvis === 'refresh') {
      for (const f of refreshers) f(m)
    } else if (m.jarvis === 'host') {
      for (const f of hostListeners) f(m)
    } else if (m.jarvis === 'theme') {
      document.documentElement.dataset.theme = m.dark ? 'dark' : 'light'
    }
  })
  const send = (message) =>
    new Promise((resolve) => {
      const id = next++
      waiting.set(id, { resolve })
      window.parent.postMessage({ ...message, id }, '*')
    })
  window.jarvis = {
    call: (tool, args = {}) => send({ jarvis: 'call', tool, args }),
    async json(tool, args = {}) {
      const r = await send({ jarvis: 'call', tool, args })
      if (!r || typeof r.text !== 'string') throw new Error('No answer from the plugin.')
      if (r.isError) throw new Error(r.text)
      return JSON.parse(r.text)
    },
    onRefresh: (f) => refreshers.push(f),
    onHost: (f) => hostListeners.push(f),
    setStatus: (status) => window.parent.postMessage({ jarvis: 'status', status: status ?? null }, '*'),
    ask: (text) => window.parent.postMessage({ jarvis: 'ask', text: String(text).slice(0, 4000) }, '*'),
    open: (url) => window.parent.postMessage({ jarvis: 'open', url: String(url) }, '*'),
  }
  window.parent.postMessage({ jarvis: 'ready' }, '*')
})()
