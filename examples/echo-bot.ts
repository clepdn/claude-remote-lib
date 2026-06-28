/**
 * Minimal example: an "echo bot" that appears as a session in claude.ai but
 * runs NO Claude inference — it just echoes each user message back.
 *
 * Run:
 *   CLAUDE_OAUTH_TOKEN=sk-ant-... npx tsx examples/echo-bot.ts
 *
 * Replace `runMyInference` with any model call (or none) — that's the whole
 * point: the library never touches Claude the model, only Claude's servers.
 */

import { Bridge } from '../src/index.js'

// Provide your claude.ai OAuth access token. The library uses it only to
// create the session + fetch worker credentials — never for inference.
const oauthToken = process.env.CLAUDE_OAUTH_TOKEN
if (!oauthToken) {
  console.error('Set CLAUDE_OAUTH_TOKEN (a claude.ai OAuth access token).')
  process.exit(1)
}

// Your inference. Any model, or a rule, or a database lookup — anything.
async function runMyInference(userText: string): Promise<string> {
  return `echo: ${userText}`
}

const bridge = new Bridge({
  getAccessToken: () => oauthToken,
  title: 'echo-bot',
  log: msg => console.error(`[bridge] ${msg}`),
  handlers: {
    // The Claude-agnostic seam: a user message arrived from claude.ai.
    // Run YOUR inference, then ship the reply with bridge.send(...).
    onInboundMessage: async msg => {
      const text =
        typeof msg.message.content === 'string'
          ? msg.message.content
          : msg.message.content
              .map(b => (b.type === 'text' ? b.text : ''))
              .join('')
      console.log(`user said: ${text}`)
      const reply = await runMyInference(text)
      await bridge.sendText(reply)
    },
    // Permission prompts (e.g. "may I run this tool?"). Deny by default
    // since this bot has no tools — wire to your own policy as needed.
    onControlRequest: async req => {
      console.log(`control_request: ${req.request.subtype}`)
      await bridge.respondToPermission(req.request_id, {
        behavior: 'deny',
        message: 'echo-bot has no tools',
      })
    },
    onConnect: () => console.log('✓ session live in claude.ai'),
    onDisconnect: reason => console.error(`disconnected: ${reason}`),
  },
})

await bridge.start()
console.log(`session url: ${bridge.sessionUrl}`)

// Graceful shutdown.
process.on('SIGINT', async () => {
  await bridge.stop()
  process.exit(0)
})
