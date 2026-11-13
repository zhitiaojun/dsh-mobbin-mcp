import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

export const VERSION = '0.1.0'

const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** Same public naming contract dsh-mcp-client uses: mcp__<server>__<tool>. */
export function publicToolName(serverName, rawName) {
  const candidate = ('mcp__' + serverName + '__' + rawName).replace(INVALID_NAME_CHARS, '_')
  if (candidate.length <= MAX_PUBLIC_NAME_LENGTH && candidate === 'mcp__' + serverName + '__' + rawName) {
    return candidate
  }
  if (candidate.length <= MAX_PUBLIC_NAME_LENGTH) return candidate
  const digest = createHash('sha256').update(serverName + '\0' + rawName).digest('hex').slice(0, HASH_LENGTH)
  return candidate.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1) + '_' + digest
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function diagnostic(block, reason) {
  const media = isRecord(block) && typeof block.mimeType === 'string' ? block.mimeType : 'unknown media type'
  return '[image unavailable: ' + media + '; ' + reason + '; raw image data remains available to programmatic callers]'
}

function decodeImage(block) {
  if (!IMAGE_MEDIA_TYPES.includes(block.mimeType)) {
    throw new Error('the declared media type is not PNG, JPEG, WebP, or GIF')
  }
  if (typeof block.data !== 'string' || !CANONICAL_BASE64.test(block.data)) {
    throw new Error('the image data is not canonical base64')
  }
  const data = Buffer.from(block.data, 'base64')
  if (data.toString('base64') !== block.data) {
    throw new Error('the image data is not canonical base64')
  }
  return { data, mediaType: block.mimeType }
}

function isImageBlock(value) {
  return isRecord(value) && value.type === 'image'
}

/**
 * Convert MCP content blocks into model-visible blocks, coalescing text runs
 * and letting the caller decide what each image block becomes.
 */
function projectBlocks(content, toolName, image) {
  const projected = []
  const text = []
  const flush = () => {
    if (text.length === 0) return
    projected.push({ type: 'text', text: text.join('\n') })
    text.length = 0
  }
  for (const [index, block] of content.entries()) {
    if (!isRecord(block)) {
      text.push(diagnostic(block, 'the block is not an object'))
      continue
    }
    if (block.type === 'text') {
      text.push(typeof block.text === 'string' ? block.text : '')
      continue
    }
    if (block.type === 'image') {
      flush()
      projected.push(image(block, index))
      continue
    }
    if (block.type === 'resource' || block.type === 'audio') {
      text.push(diagnostic(block, 'this block type is not admitted to model context'))
      continue
    }
    text.push(diagnostic(block, 'unsupported MCP content block'))
  }
  flush()
  if (projected.length === 0) {
    return [{ type: 'text', text: '(' + toolName + ' returned no model-visible content)' }]
  }
  return projected
}

function contentAsText(content, toolName) {
  return projectBlocks(content, toolName, (block) => ({
    type: 'text',
    text: diagnostic(block, 'images are not admitted to text-only results'),
  }))
    .map((block) => block.text || '')
    .join('\n')
}

async function resolveImageAdmission(ctx, exec) {
  const route = exec && exec.agent && typeof exec.agent.session === 'object'
    ? exec.agent.session.requestHeader().config
    : undefined
  if (route && typeof route === 'object' && (route.provider || route.model)) {
    if (!route.provider || !route.model) {
      throw new Error('the active model route is incomplete')
    }
    const llm = ctx.get('llm')
    if (!llm || typeof llm.resolveModelInfo !== 'function') {
      throw new Error('the active model is not known to this process')
    }
    const info = await llm.resolveModelInfo(route.provider, route.model, exec.signal)
    const inputModalities = info && info.inputModalities
    if (!Array.isArray(inputModalities) || !inputModalities.includes('image')) {
      throw new Error('the active model does not accept image input')
    }
  }
  const attachments = ctx.get('attachments')
  if (!attachments || typeof attachments.saveImages !== 'function') {
    throw new Error('no attachment store is mounted in this process')
  }
  return attachments
}

async function prepareImageProjection(ctx, exec, content, toolName) {
  const decoded = []
  const rejected = new Map()
  const indexes = []
  for (const [index, block] of content.entries()) {
    if (!isImageBlock(block)) continue
    indexes.push(index)
    try {
      decoded.push(decodeImage(block))
    } catch (error) {
      rejected.set(index, error instanceof Error ? error.message : String(error))
    }
  }
  if (rejected.size > 0) {
    return projectBlocks(content, toolName, (block, index) => ({
      type: 'text',
      text: diagnostic(block, rejected.get(index) || 'another image in the same result was invalid'),
    }))
  }
  let attachments
  try {
    attachments = await resolveImageAdmission(ctx, exec)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return projectBlocks(content, toolName, (block) => ({ type: 'text', text: diagnostic(block, reason) }))
  }
  try {
    const refs = await attachments.saveImages(decoded)
    if (!Array.isArray(refs) || refs.length !== indexes.length) {
      throw new Error('the attachment store returned an unexpected number of refs')
    }
    const byIndex = new Map(indexes.map((index, offset) => [index, refs[offset]]))
    return projectBlocks(content, toolName, (block, index) => ({
      type: 'image',
      attachment: byIndex.get(index),
    }))
  } catch {
    return projectBlocks(content, toolName, (block) => ({
      type: 'text',
      text: diagnostic(block, 'durable image storage rejected the result'),
    }))
  }
}

/** Register a plain text-shaped tool (used for the authorize entry point). */
export function textTool(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: { content: { type: 'array', items: {} } },
        required: ['content'],
        additionalProperties: false,
      },
      render(args, value) {
        const content = (value && Array.isArray(value.content)) ? value.content : []
        return [{ type: 'text', text: content.map((block) => (block && block.text) || '').join('\n') }]
      },
    },
    async execute(args, exec) {
      const value = await definition.execute(exec)
      return { content: [{ type: 'text', text: String(value) }] }
    },
  }
}

/**
 * Owns the MCP client, the registered Mobbin tools, and image projection.
 */
export function createBridge({ ctx, config, store, log }) {
  const projections = new WeakMap()
  const disposers = new Map()
  let client
  let transport

  function currentClient() {
    if (!client) throw new Error('Mobbin is not connected yet')
    return client
  }

  async function disposeConnection() {
    const previous = client
    const previousTransport = transport
    client = undefined
    transport = undefined
    if (previous || previousTransport) {
      try {
        if (previousTransport && typeof previousTransport.close === 'function') await previousTransport.close()
        else if (previous && typeof previous.close === 'function') await previous.close()
      } catch {
        // Closing a dead transport is best effort.
      }
    }
  }

  async function connect() {
    await disposeConnection()
    const nextTransport = new StreamableHTTPClientTransport(new URL(config.url), {
      authProvider: {
        token: async () => store.accessToken(),
        onUnauthorized: async () => {
          try {
            await store.refresh()
          } catch {
            // Let the transport surface the 401 instead of a refresh error.
          }
        },
      },
    })
    const nextClient = new Client({ name: 'dsh-mobbin-mcp', version: VERSION }, { capabilities: {} })
    await nextClient.connect(nextTransport)
    client = nextClient
    transport = nextTransport
    return nextClient
  }

  function buildTool(rawName) {
    return {
      name: publicToolName(config.serverName, rawName),
      description: rawName,
      parameters: { type: 'object', additionalProperties: true },
      output: {
        schema: {
          type: 'object',
          properties: {
            content: { type: 'array', items: {} },
            structuredContent: {},
          },
          required: ['content'],
          additionalProperties: false,
        },
        render(args, value) {
          const content = value && Array.isArray(value.content) ? value.content : []
          return [{ type: 'text', text: contentAsText(content, rawName) }]
        },
      },
      async execute(args, exec) {
        const params = isRecord(args) ? args : {}
        let result
        try {
          result = await currentClient().callTool(
            { name: rawName, arguments: params },
            { signal: exec.signal, timeout: config.toolCallTimeoutMs },
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new Error('Mobbin tool "' + rawName + '" failed: ' + message)
        }
        const content = Array.isArray(result.content) ? result.content : []
        if (result.isError === true) {
          throw new Error(contentAsText(content, rawName))
        }
        const value = { content }
        if (result.structuredContent !== undefined) value.structuredContent = result.structuredContent
        if (content.some(isImageBlock)) {
          const fallback = [{ type: 'text', text: contentAsText(content, rawName) }]
          const projected = await prepareImageProjection(ctx, exec, content, rawName)
          projections.set(exec, { value, fallback, content: projected })
        }
        return value
      },
      projectContent(exec, result) {
        const projection = projections.get(exec)
        if (!projection) return undefined
        projections.delete(exec)
        if (result.isError) return undefined
        if (!isDeepStrictEqual(result.value, projection.value)) return undefined
        if (!isDeepStrictEqual(result.content, projection.fallback)) return undefined
        return projection.content
      },
    }
  }

  /** Ask Mobbin for its tool list and swap the registered tools atomically. */
  async function syncTools() {
    let listed
    try {
      listed = await currentClient().listTools()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error('Mobbin tool discovery failed: ' + message)
    }
    const tools = Array.isArray(listed && listed.tools) ? listed.tools : []
    const next = new Map()
    for (const entry of tools) {
      if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name.length === 0) continue
      const publicName = publicToolName(config.serverName, entry.name)
      if (next.has(publicName)) {
        throw new Error('Mobbin exposed two tools that map to the same public name: ' + publicName)
      }
      const definition = buildTool(entry.name)
      if (isRecord(entry.inputSchema)) definition.parameters = entry.inputSchema
      if (typeof entry.description === 'string') definition.description = entry.description
      next.set(publicName, definition)
    }
    if (next.size === 0) throw new Error('Mobbin exposed no tools')
    for (const dispose of disposers.values()) dispose()
    disposers.clear()
    for (const [publicName, definition] of next) {
      disposers.set(publicName, ctx.tools.register(definition))
    }
    if (typeof log === 'function') log('info', 'registered ' + next.size + ' Mobbin tools')
    return Array.from(next.keys())
  }

  return {
    connect,
    syncTools,
    toolName: (rawName) => publicToolName(config.serverName, rawName),
    isConnected: () => Boolean(client),
    async dispose() {
      for (const dispose of disposers.values()) dispose()
      disposers.clear()
      await disposeConnection()
    },
  }
}
