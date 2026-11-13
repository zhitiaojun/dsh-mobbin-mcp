#!/usr/bin/env node
// Read-only diagnostics: what Mobbin advertises, and whether this client can
// register with it and reach the authorization page.
import { discover } from '../lib/oauth.js'

const serverUrl = process.argv[2] || 'https://api.mobbin.com/mcp'

const info = await discover(serverUrl)
console.log('resource          ' + info.resource)
console.log('issuer            ' + info.issuer)
console.log('authorize         ' + info.metadata.authorization_endpoint)
console.log('token             ' + info.metadata.token_endpoint)
console.log('registration      ' + info.metadata.registration_endpoint)
console.log('scopes            ' + (info.metadata.scopes_supported || []).join(' '))
console.log('pkce methods      ' + (info.metadata.code_challenge_methods_supported || []).join(' '))

const redirectUri = 'http://127.0.0.1:14565/callback'
const response = await fetch(info.metadata.registration_endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify({
    client_name: 'DeepSeek Harness (dsh-mobbin-mcp probe)',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: 'openid offline_access',
  }),
})
const registration = await response.json().catch(() => ({}))
if (!response.ok || !registration.client_id) {
  console.error('registration failed: HTTP ' + response.status + ' ' + JSON.stringify(registration).slice(0, 300))
  process.exitCode = 1
} else {
  console.log('client_id         ' + registration.client_id)
  const target = new URL(info.metadata.authorization_endpoint)
  target.searchParams.set('response_type', 'code')
  target.searchParams.set('client_id', registration.client_id)
  target.searchParams.set('redirect_uri', redirectUri)
  target.searchParams.set('scope', 'openid')
  target.searchParams.set('state', 'probe')
  target.searchParams.set('code_challenge', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  target.searchParams.set('code_challenge_method', 'S256')
  target.searchParams.set('resource', info.resource)
  const page = await fetch(target, { redirect: 'manual' })
  console.log('authorize page    HTTP ' + page.status + (page.headers.get('location') ? ' -> ' + page.headers.get('location') : ''))
}
