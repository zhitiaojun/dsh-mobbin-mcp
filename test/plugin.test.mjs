import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../lib/index.js'

function fakeContext(registered) {
  return {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    get() {
      return undefined
    },
    logger: { info() {}, warn() {}, error() {} },
    effect(factory) {
      factory()
    },
    on() {},
  }
}

test('config defaults point at the public Mobbin endpoint', () => {
  const config = Config({})
  assert.equal(config.url, 'https://api.mobbin.com/mcp')
  assert.equal(config.serverName, 'mobbin')
  assert.equal(config.scope, 'openid offline_access')
  assert.equal(config.autoAuthorize, false)
})

test('without credentials the plugin exposes only the authorize tool', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mobbin-plugin-'))
  const registered = []
  try {
    await apply(fakeContext(registered), { tokenFile: join(dir, 'oauth.json') })
    assert.equal(registered.length, 1)
    assert.equal(registered[0].name, 'mcp__mobbin__authorize')
    assert.equal(typeof registered[0].execute, 'function')
    assert.ok(registered[0].description.includes('Authorize'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
