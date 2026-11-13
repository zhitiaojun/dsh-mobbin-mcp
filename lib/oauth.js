import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

const REQUEST_TIMEOUT_MS = 20000
const FLOW_TIMEOUT_MS = 300000

/** Store OAuth state next to the other DSH machine-local data. */
export function defaultTokenFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'mobbin-mcp', 'oauth.json')
}

/** Open a URL in the platform browser without blocking the host process. */
export function openInBrowser(target) {
  const platform = process.platform
  try {
    // cmd.exe splits its command line at '&', so the URL has to stay one quoted argument,
    // and Node's default arg quoting escapes the quotes in a way cmd does not understand —
    // hence windowsVerbatimArguments with the quotes written out by hand.
    const child = platform === 'win32'
      ? spawn('cmd.exe', ['/c', 'start', '""', '"' + target + '"'], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true })
      : spawn(platform === 'darwin' ? 'open' : 'xdg-open', [target], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    if (character === '&') return '&amp;'
    if (character === '<') return '&lt;'
    if (character === '>') return '&gt;'
    if (character === '"') return '&quot;'
    return '&#39;'
  })
}

async function requestJson(url, init) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const headers = Object.assign({ accept: 'application/json' }, init && init.headers ? init.headers : {})
    const response = await fetch(url, Object.assign({}, init, { headers, signal: controller.signal }))
    const body = await response.text()
    if (!response.ok) {
      throw new Error('HTTP ' + response.status + ' from ' + url + (body ? ': ' + body.slice(0, 300) : ''))
    }
    return body ? JSON.parse(body) : {}
  } finally {
    clearTimeout(timer)
  }
}

function listen(server, preferredPort) {
  return new Promise((resolve, reject) => {
    const attempt = (port) => {
      const onError = (error) => {
        server.off('listening', onListening)
        if (error && error.code === 'EADDRINUSE' && port !== 0) {
          attempt(0)
          return
        }
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve(server.address().port)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    }
    attempt(preferredPort || 0)
  })
}

/**
 * Persisted OAuth credentials for one Mobbin account.
 * Tokens are cached in memory and written with owner-only permissions.
 */
export class TokenStore {
  constructor(file) {
    this.file = file
    this.state = undefined
    this.loaded = false
    this.pendingRefresh = undefined
  }

  async load() {
    if (this.loaded) return this.state
    try {
      const raw = await readFile(this.file, 'utf8')
      this.state = JSON.parse(raw)
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
      this.state = undefined
    }
    this.loaded = true
    return this.state
  }

  /** Drop the in-memory copy so the next read sees a file written by another instance. */
  async reload() {
    this.loaded = false
    this.state = undefined
    return this.load()
  }

  async save(state) {
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
    try {
      await chmod(this.file, 0o600)
    } catch {
      // Windows does not always honour POSIX modes; the file stays user-scoped anyway.
    }
    this.state = state
    this.loaded = true
  }

  async hasTokens() {
    const state = await this.load()
    return Boolean(state && state.access_token)
  }

  /** Bearer token for the next request, refreshed shortly before expiry. */
  async accessToken() {
    const state = await this.load()
    if (!state || !state.access_token) {
      throw new Error('Mobbin is not authorized yet')
    }
    if (state.expires_at && Date.now() > state.expires_at - 60000) {
      try {
        await this.refresh()
      } catch {
        return state.access_token
      }
    }
    return state.access_token
  }

  /** Refresh once even when several requests race the same expiry. */
  async refresh() {
    if (this.pendingRefresh) return this.pendingRefresh
    this.pendingRefresh = this.refreshOnce().finally(() => {
      this.pendingRefresh = undefined
    })
    return this.pendingRefresh
  }

  async refreshOnce() {
    const state = await this.load()
    if (!state || !state.refresh_token) {
      throw new Error('Mobbin token refresh failed: no refresh token stored')
    }
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: state.refresh_token,
      client_id: state.client_id,
    })
    if (state.client_secret) body.set('client_secret', state.client_secret)
    const tokens = await requestJson(state.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    const next = Object.assign({}, state, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || state.refresh_token,
      expires_at: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
      scope: tokens.scope || state.scope,
      refreshed_at: Date.now(),
    })
    await this.save(next)
    return next
  }
}

/** Discover the protected-resource and authorization-server metadata. */
export async function discover(serverUrl) {
  const url = new URL(serverUrl)
  const protectionCandidates = [
    url.origin + '/.well-known/oauth-protected-resource' + url.pathname,
    url.origin + '/.well-known/oauth-protected-resource',
  ]
  let protection
  let lastError
  for (const candidate of protectionCandidates) {
    try {
      protection = await requestJson(candidate)
      break
    } catch (error) {
      lastError = error
    }
  }
  if (!protection) {
    throw lastError || new Error('Mobbin did not advertise OAuth protected-resource metadata')
  }
  const issuer = (protection.authorization_servers && protection.authorization_servers[0]) || url.origin
  const metadataCandidates = [
    issuer + '/.well-known/oauth-authorization-server',
    issuer + '/.well-known/openid-configuration',
  ]
  let metadata
  for (const candidate of metadataCandidates) {
    try {
      metadata = await requestJson(candidate)
      break
    } catch (error) {
      lastError = error
    }
  }
  if (!metadata) {
    throw lastError || new Error('Mobbin did not advertise authorization-server metadata')
  }
  return { protection, issuer, metadata, resource: protection.resource || serverUrl }
}

/**
 * Run the interactive OAuth 2.0 authorization-code flow with PKCE and dynamic
 * client registration. Resolves only after tokens are stored on disk.
 */
export async function authorize(options) {
  const { serverUrl, scope, callbackPort, tokenFile } = options
  const server = createServer()
  let settle
  const codePromise = new Promise((resolve, reject) => {
    settle = { resolve, reject }
  })
  let timer

  server.on('request', (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return
    }
    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (error) {
      response.end('<html><body><h3>Mobbin authorization failed</h3><p>' + escapeHtml(error) + '</p></body></html>')
    } else {
      response.end('<html><body><h3>Mobbin is connected</h3><p>You can close this window and return to DeepSeek Harness.</p></body></html>')
    }
    if (timer) clearTimeout(timer)
    if (error) {
      settle.reject(new Error('Mobbin authorization failed: ' + error + ' ' + (url.searchParams.get('error_description') || '')))
    } else if (code) {
      settle.resolve({ code, state: url.searchParams.get('state') || '' })
    } else {
      settle.reject(new Error('Mobbin authorization callback carried neither code nor error'))
    }
  })

  const port = await listen(server, callbackPort)
  const redirectUri = 'http://127.0.0.1:' + port + '/callback'

  try {
    const info = await discover(serverUrl)
    if (!info.metadata.registration_endpoint || !info.metadata.authorization_endpoint || !info.metadata.token_endpoint) {
      throw new Error('Mobbin authorization server metadata is incomplete')
    }
    const registration = await requestJson(info.metadata.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'DeepSeek Harness (dsh-mobbin-mcp)',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope,
      }),
    })
    if (!registration.client_id) throw new Error('Mobbin dynamic client registration returned no client_id')

    const verifier = base64url(randomBytes(32))
    const challenge = base64url(createHash('sha256').update(verifier).digest())
    const state = base64url(randomBytes(16))

    const target = new URL(info.metadata.authorization_endpoint)
    target.searchParams.set('response_type', 'code')
    target.searchParams.set('client_id', registration.client_id)
    target.searchParams.set('redirect_uri', redirectUri)
    target.searchParams.set('scope', scope)
    target.searchParams.set('state', state)
    target.searchParams.set('code_challenge', challenge)
    target.searchParams.set('code_challenge_method', 'S256')
    target.searchParams.set('resource', info.resource)

    if (typeof options.onAuthorizeUrl === 'function') options.onAuthorizeUrl(target.toString())
    if (options.openBrowser !== false) openInBrowser(target.toString())

    timer = setTimeout(() => {
      settle.reject(new Error('Mobbin authorization timed out after ' + Math.round(FLOW_TIMEOUT_MS / 1000) + ' seconds'))
    }, FLOW_TIMEOUT_MS)

    const result = await codePromise
    if (result.state && result.state !== state) {
      throw new Error('Mobbin authorization state mismatch')
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: result.code,
      redirect_uri: redirectUri,
      client_id: registration.client_id,
      code_verifier: verifier,
      resource: info.resource,
    })
    if (registration.client_secret) body.set('client_secret', registration.client_secret)

    const tokens = await requestJson(info.metadata.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    if (!tokens.access_token) throw new Error('Mobbin token exchange returned no access token')

    const stored = {
      issuer: info.issuer,
      resource: info.resource,
      scope: tokens.scope || scope,
      client_id: registration.client_id,
      client_secret: registration.client_secret,
      authorization_endpoint: info.metadata.authorization_endpoint,
      token_endpoint: info.metadata.token_endpoint,
      registration_endpoint: info.metadata.registration_endpoint,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
      saved_at: Date.now(),
    }
    await new TokenStore(tokenFile).save(stored)
    return stored
  } finally {
    if (timer) clearTimeout(timer)
    server.close()
  }
}
