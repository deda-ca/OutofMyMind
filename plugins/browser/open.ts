// npm run browser [url…]: open Jarvis's Chrome (see chrome.ts) to use it
// yourself, or to sign it in to its accounts. If it's already open, the URLs
// open in it as new tabs.

import { chromeRunning, endpoint, ensureChrome, profileDir } from './chrome.ts'

const urls = process.argv.slice(2)
try {
  if (await chromeRunning()) {
    for (const url of urls) await fetch(`${endpoint}/json/new?${encodeURI(url)}`, { method: 'PUT' })
    console.log(`Jarvis's browser is already open${urls.length ? '; opened the page(s) in it' : ''}.`)
  } else {
    await ensureChrome(urls)
    console.log(`Opened Jarvis's browser (profile: ${profileDir}). It stays open after this command ends.`)
  }
} catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}
