import { z } from 'zod'
import { createPlugin, emit, notify, pluginDataDir, serve, text } from '../../../../../plugins/kit/plugin.ts'

const plugin = createPlugin('echo', '0.1.0', 'Test plugin.')
plugin.registerTool('say', { description: 'Emits echo.said.', inputSchema: { words: z.string() } }, async ({ words }) => {
  emit(plugin, 'echo.said', { words }, `said-${words}`)
  emit(plugin, 'echo.undeclared', { words })
  await notify(plugin, 'Echo', `heard: ${words}`)
  return text(`said ${words} (data ${pluginDataDir ? 'yes' : 'no'}, setting ${process.env.ECHO_SETTING ?? 'none'}, secret ${process.env.SECRET_NOT_NAMED ?? 'none'})`)
})
plugin.registerTool('send', { description: 'Sends.', inputSchema: { to: z.string() } }, async ({ to }) => text(`sent to ${to}`))
plugin.registerTool('tab_only', { description: 'For the tab.', inputSchema: {} }, async () => text('tab data'))
await serve(plugin)
