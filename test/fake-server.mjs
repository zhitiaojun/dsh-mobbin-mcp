import { createServer } from 'node:http'

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** Minimal Streamable HTTP MCP server exposing two Mobbin-shaped tools. */
export function startFakeMobbin() {
  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'text/plain' })
      res.end('method not allowed')
      return
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      let message = {}
      try {
        message = JSON.parse(body || '{}')
      } catch {
        message = {}
      }
      if (message.id === undefined) {
        res.writeHead(202)
        res.end()
        return
      }
      const send = (payload) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      const reply = (result) => send({ jsonrpc: '2.0', id: message.id, result })
      const fail = (code, text) => send({ jsonrpc: '2.0', id: message.id, error: { code, message: text } })

      if (message.method === 'initialize') {
        reply({
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-mobbin', version: '0.0.0' },
        })
        return
      }
      if (message.method === 'tools/list') {
        reply({
          tools: [
            {
              name: 'search_screens',
              description: 'Search Mobbin screens',
              inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
            },
            {
              name: 'list collections/v2',
              description: 'List collections',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        })
        return
      }
      if (message.method === 'tools/call') {
        const params = message.params || {}
        if (params.name === 'search_screens') {
          if (!params.arguments || typeof params.arguments.query !== 'string') {
            reply({ content: [{ type: 'text', text: 'query is required' }], isError: true })
            return
          }
          reply({
            content: [
              { type: 'text', text: 'Found 1 screen' },
              { type: 'image', mimeType: 'image/png', data: PNG_1PX },
            ],
            structuredContent: { count: 1 },
          })
          return
        }
        reply({ content: [{ type: 'text', text: 'collections' }] })
        return
      }
      fail(-32601, 'method not found: ' + String(message.method))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        url: 'http://127.0.0.1:' + port + '/mcp',
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}
