#!/usr/bin/env node
import { authorize, defaultTokenFile } from '../lib/oauth.js'

const tokenFile = process.argv[2] || defaultTokenFile()

try {
  const stored = await authorize({
    serverUrl: 'https://api.mobbin.com/mcp',
    scope: 'openid offline_access',
    callbackPort: 14565,
    tokenFile,
    openBrowser: true,
    onAuthorizeUrl(target) {
      console.log('If the browser did not open, visit:')
      console.log('  ' + target)
    },
  })
  console.log('Mobbin tokens stored in ' + tokenFile)
  console.log('Granted scope: ' + stored.scope)
} catch (error) {
  console.error('Authorization failed: ' + (error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
}
