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
  autoAuthorize: z.boolean().default(false).description('Start the authorization flow at startup when no tokens are stored.'),
  openBrowser: z.boolean().default(true).description('Try to open the authorization URL in the default browser.'),
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
  let statusToolDispose
  let authInFlight
  let disposed = false
  let urlResolve
  let urlPromise = new Promise((resolve) => {
    urlResolve = resolve
  })
  // The flow outlives the tool call: the callback arrives whenever the user finishes in
  // the browser, which can be minutes later, so the tool reports the URL and returns.
  const authState = { status: 'idle', url: '', error: '' }

  function removeAuthTools() {
    if (authToolDispose) {
      authToolDispose()
      authToolDispose = undefined
    }
    if (statusToolDispose) {
      statusToolDispose()
      statusToolDispose = undefined
    }
  }

  function startAuthorization() {
    if (authInFlight) return authInFlight
    authState.status = 'running'
    authState.url = ''
    authState.error = ''
    urlPromise = new Promise((resolve) => {
      urlResolve = resolve
    })
    authInFlight = authorize({
      serverUrl: settings.url,
      scope: settings.scope,
      callbackPort: settings.callbackPort,
      tokenFile: settings.tokenFile,
      openBrowser: settings.openBrowser,
      onAuthorizeUrl(target) {
        authState.url = target
        log('info', 'authorize at ' + target)
        if (urlResolve) {
          urlResolve(target)
          urlResolve = undefined
        }
      },
    })
      .then(async () => {
        authState.url = ''
        await bridge.connect()
        await bridge.syncTools()
        authState.status = 'connected'
        log('info', 'Mobbin connected')
        removeAuthTools()
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        authState.status = 'failed'
        authState.error = message
        log('warn', 'Mobbin authorization failed: ' + message)
      })
      .finally(() => {
        authInFlight = undefined
      })
    return authInFlight
  }

  function waitForUrl(ms) {
    if (authState.url) return Promise.resolve(authState.url)
    return Promise.race([
      urlPromise,
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(''), ms)
        if (typeof timer.unref === 'function') timer.unref()
      }),
    ])
  }

  function registerAuthTools() {
    if (disposed) return
    if (!authToolDispose) {
      authToolDispose = ctx.tools.register(
        textTool({
          name: bridge.toolName('authorize'),
          description:
            'Authorize DeepSeek Harness with Mobbin (OAuth 2.0, PKCE). Starts the flow, opens a browser window ' +
            'when possible and returns the URL to approve; after approval the Mobbin search and collection tools appear. ' +
            'Call this when Mobbin tools are missing or a call reports that authorization expired.',
          async execute() {
            if (authState.status === 'connected') return 'Mobbin is already connected; its tools are available.'
            startAuthorization()
            const url = await waitForUrl(20000)
            if (!url) {
              return 'Mobbin authorization is starting, but the approval URL is not ready yet. Call ' + bridge.toolName('authorize_status') + ' in a few seconds.'
            }
            return (
              'Approve access to Mobbin at this URL:\n' + url +
              '\n\nA browser window may have opened already. After approving, call ' +
              bridge.toolName('authorize_status') + ' to confirm the connection.'
            )
          },
        }),
      )
    }
    if (!statusToolDispose) {
      statusToolDispose = ctx.tools.register(
        textTool({
          name: bridge.toolName('authorize_status'),
          description:
            'Report the state of the Mobbin authorization flow: idle, running (with the approval URL), ' +
            'failed (with the error) or connected.',
          async execute() {
            if (authState.status === 'connected') return 'Mobbin is connected; its tools are available.'
            if (authState.status === 'failed') {
              return 'Mobbin authorization failed: ' + authState.error + '\nCall ' + bridge.toolName('authorize') + ' to start a new attempt.'
            }
            if (authState.status === 'running') {
              return 'Mobbin authorization is waiting for approval at:\n' + (authState.url || '(URL not ready yet)')
            }
            return 'No Mobbin authorization in progress. Call ' + bridge.toolName('authorize') + ' to start one.'
          },
        }),
      )
    }
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
    removeAuthTools()
    void bridge.dispose()
  }

  if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'mobbin-mcp.connection')
  else ctx.on('dispose', dispose)

  const connected = await tryConnect()
  if (!connected) {
    registerAuthTools()
    if (settings.autoAuthorize) {
      void startAuthorization()
    } else {
      log('info', 'no Mobbin credentials yet; call ' + bridge.toolName('authorize') + ' to authorize')
    }
  }
}
