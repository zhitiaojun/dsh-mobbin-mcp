import test from 'node:test'
import assert from 'node:assert/strict'
import { publicToolName } from '../lib/mobbin.js'

test('public names use the mcp__<server>__<tool> contract', () => {
  assert.equal(publicToolName('mobbin', 'search_screens'), 'mcp__mobbin__search_screens')
})

test('unsafe characters become underscores', () => {
  assert.equal(publicToolName('mobbin', 'search screens/v2'), 'mcp__mobbin__search_screens_v2')
})

test('over-long names are truncated and suffixed with a stable digest', () => {
  const raw = 'x'.repeat(120)
  const name = publicToolName('mobbin', raw)
  assert.equal(name.length, 64)
  assert.match(name, /^mcp__mobbin__x+_[0-9a-f]{12}$/)
  assert.equal(publicToolName('mobbin', raw), name)
  assert.notEqual(publicToolName('mobbin', raw + 'y'), name)
})

test('the same raw name under different servers stays distinct', () => {
  assert.notEqual(publicToolName('mobbin', 'a'), publicToolName('mobbin2', 'a'))
})
