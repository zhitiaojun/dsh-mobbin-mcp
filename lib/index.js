import z from '@deepseek-ai/schemastery'
import { authorize, defaultTokenFile, TokenStore } from './oauth.js'
import { createBridge, textTool } from './mobbin.js'

export const name = 'dsh-mobbin-mcp'
export const inject = ['tools']

export const Config = z.object({
  serverName: z.string().default('mobbin').description('Prefix for the public tool names (mcp__<serverName>__<tool>).'),
  url: z.string().default('https://api.mobbin.com/mcp').description('Mobbin MCP endpoint (Streamable HTTP).'),
  scope: z.string().default('openid offline_access').description('OAuth scope requested during authorization; offline_access yields a refresh token.'),
  tokenFile: z.string().default('').description('Where to store OAuth tokens; defaults to $DSH_HOME/mobbin-mcp/oauth.json.'),
  callbackPort: z.number().default(14565).description('Loopback port for the OAuth redirect (falls back to a free port).'),
  autoAuthorize: z.boolean().default(false).description('Start the browser authorization flow at startup when no tokens are stored.'),
  openBrowser: z.boolean().default(true).description('Open the authorization URL in the default browser.'),
  toolCallTimeoutMs: z.number().default(60000).description('Per-call timeout for Mobbin tools.'),
})

const DEFAULTS = {
  serverName: 'mobbin',
  url: 'https://api.mobbin.com/mcp',
  scope: 'openid offline_access',
  tokenFile: '',
  callbackPort: 14565,
  autoAuthorize: false,
  openBrowser: true,
  toolCallTimeoutMs: 60000,
}

export async function apply(ctx, config) {
  const settings = Object.assign({}, DEFAULTS, config || {})
  settings.tokenFile = settings.tokenFile || defaultTokenFile()

  const log = (level, message) => {
    try {
      const logger = ctx.logger
      if (logger && typeof logger[level] === 'function') logger[level]('[mobbin-mcp] ' + message)
    } catch {
      // Logging must never break plugin startup.
    }
  }

  const store = new TokenStore(settings.tokenFile)
  const bridge = createBridge({ ctx, config: settings, store, log })

  let authToolDispose
  let authInFlight
  let disposed = false

  async function runAuthorization() {
    if (authInFlight) return authInFlight
    authInFlight = (async () => {
      log('info', 'starting Mobbin authorization; a browser window will open')
      await authorize({
        serverUrl: settings.url,
        scope: settings.scope,
        callbackPort: settings.callbackPort,
        tokenFile: settings.tokenFile,
        openBrowser: settings.openBrowser,
        onAuthorizeUrl: (target) => log('info', 'authorize at ' + target),
      })
      await bridge.connect()
      await bridge.syncTools()
      if (authToolDispose) {
        authToolDispose()
        authToolDispose = undefined
      }
      log('info', 'Mobbin connected')
    })().finally(() => {
      authInFlight = undefined
    })
    return authInFlight
  }

  function registerAuthTool() {
    if (authToolDispose || disposed) return
    authToolDispose = ctx.tools.register(
      textTool({
        name: bridge.toolName('authorize'),
        description:
          'Authorize DeepSeek Harness with Mobbin (OAuth 2.0, PKCE). Opens a browser window; ' +
          'after the user approves access the Mobbin search and collection tools appear. ' +
          'Call this when Mobbin tools are missing or a call reports that authorization expired.',
        async execute() {
          await runAuthorization()
          return 'Mobbin is connected. Its tools are now available.'
        },
      }),
    )
  }

  async function tryConnect() {
    if (!(await store.hasTokens())) return false
    try {
      await bridge.connect()
      await bridge.syncTools()
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('warn', 'could not connect to Mobbin: ' + message)
      return false
    }
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    if (authToolDispose) {
      authToolDispose()
      authToolDispose = undefined
    }
    void bridge.dispose()
  }

  if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'mobbin-mcp.connection')
  else ctx.on('dispose', dispose)

  const connected = await tryConnect()
  if (!connected) {
    registerAuthTool()
    if (settings.autoAuthorize) {
      void runAuthorization().catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        log('warn', 'Mobbin authorization failed: ' + message)
      })
    } else {
      log('info', 'no Mobbin credentials yet; call ' + bridge.toolName('authorize') + ' to authorize')
    }
  }
}
