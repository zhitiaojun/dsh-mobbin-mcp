import test from 'node:test'
import assert from 'node:assert/strict'
import { discover } from '../lib/oauth.js'

const offline = process.env.MOBBIN_OFFLINE === '1'

test('Mobbin advertises OAuth metadata', { skip: offline ? 'MOBBIN_OFFLINE=1' : false }, async () => {
  const info = await discover('https://api.mobbin.com/mcp')
  assert.ok(info.metadata.authorization_endpoint)
  assert.ok(info.metadata.token_endpoint)
  assert.ok(info.metadata.registration_endpoint)
  assert.ok(Array.isArray(info.protection.authorization_servers))
})
