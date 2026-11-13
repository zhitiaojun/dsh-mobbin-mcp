import test from 'node:test'
import assert from 'node:assert/strict'
import { createBridge } from '../lib/mobbin.js'
import { startFakeMobbin } from './fake-server.mjs'

const config = { serverName: 'mobbin', url: '', toolCallTimeoutMs: 15000 }
const store = { async accessToken() { return 'test-token' }, async refresh() {} }

test('bridge registers a fake Mobbin server and projects images as text fallback', async () => {
  const fake = await startFakeMobbin()
  const registered = new Map()
  const ctx = {
    tools: { register(definition) { registered.set(definition.name, definition); return () => registered.delete(definition.name) } },
    get() { return undefined },
  }
  const bridge = createBridge({ ctx, config: { ...config, url: fake.url }, store, log: () => {} })
  try {
    await bridge.connect()
    const names = await bridge.syncTools()
    assert.deepEqual(names.sort(), ['mcp__mobbin__list_collections_v2', 'mcp__mobbin__search_screens'])
    assert.equal(registered.size, 2)

    const exec = {}
    const tool = registered.get('mcp__mobbin__search_screens')
    assert.equal(tool.parameters.required[0], 'query')

    const value = await tool.execute({ query: 'onboarding' }, exec)
    assert.equal(value.content.length, 2)
    assert.deepEqual(value.structuredContent, { count: 1 })

    const rendered = tool.output.render({}, value)
    assert.match(rendered[0].text, /Found 1 screen/)
    assert.match(rendered[0].text, /\[image unavailable: image\/png;/)

    const projected = tool.projectContent(exec, { isError: false, value, content: rendered })
    assert.equal(projected.length, 2)
    assert.equal(projected[0].text, 'Found 1 screen')
    assert.match(projected[1].text, /image unavailable/)

    await assert.rejects(() => tool.execute({}, exec), /query is required/)
  } finally {
    await bridge.dispose()
    await fake.close()
  }
})

test('a second bridge can connect to the same server', async () => {
  const fake = await startFakeMobbin()
  const ctx = { tools: { register() { return () => {} } }, get() { return undefined } }
  const bridge = createBridge({ ctx, config: { ...config, url: fake.url }, store, log: () => {} })
  try {
    await bridge.connect()
    const names = await bridge.syncTools()
    assert.ok(names.length >= 1)
  } finally {
    await bridge.dispose()
    await fake.close()
  }
})
