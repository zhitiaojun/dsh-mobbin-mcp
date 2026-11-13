# dsh-mobbin-mcp

Connects the [Mobbin](https://mobbin.com) MCP server to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
Once installed you can search Mobbin's app and web UI screenshots in natural language, and the screenshots arrive as real image blocks in the model context.

Mobbin's MCP endpoint supports **OAuth 2.0 only** (no API key) — this is what the "Other" client in Mobbin's docs means. This plugin implements the whole flow with Node's built-in `fetch`:

- **Protected-resource discovery** — `https://api.mobbin.com/.well-known/oauth-protected-resource/mcp`
- **Authorization-server metadata** — `/.well-known/oauth-authorization-server`
- **Dynamic client registration (RFC 7591)** — a fresh loopback client per authorization
- **PKCE (S256) + local callback server** — `http://127.0.0.1:<port>/callback`
- **Token exchange and refresh** — tokens stored at `$DSH_HOME/mobbin-mcp/oauth.json` (mode 0600), refreshed 60 s before expiry

## Requirements

- DeepSeek Harness `>= 0.2.0`
- Node.js `>= 20`
- A **Mobbin Pro / Team / Enterprise** plan (Mobbin MCP is paid-plan only)

## Install

From GitHub:

```bash
dsh plugin --profile web add github:zhitiaojun/dsh-mobbin-mcp
```

From npm:

```bash
dsh plugin --profile web add dsh-mobbin-mcp
```

From a local checkout:

```bash
dsh plugin --profile web add .
```

## Authorizing

With no stored credentials the plugin registers a single tool:

`mcp__mobbin__authorize`

Ask the model to call it (or just say "log in to Mobbin"). It will:

1. start a loopback HTTP server for the OAuth redirect;
2. open the Mobbin authorization page in your browser (the full URL is also logged, for machines without a browser);
3. you sign in and approve;
4. the plugin exchanges the code, writes the tokens, and registers the real Mobbin tools immediately.

The authorize tool unregisters itself afterwards; later DSH starts read the stored tokens and connect quietly.

To let the plugin start the flow by itself at boot:

```yaml
config:
  autoAuthorize: true
```

You can also authorize outside DSH (same token file — handy for debugging):

```bash
npm run login
```

## Configuration

`cordis.patch.yml` keeps the minimal config; everything else is optional:

| Field | Default | Meaning |
| --- | --- | --- |
| `serverName` | `mobbin` | Prefix for public tool names (`mcp__mobbin__search_screens`) |
| `url` | `https://api.mobbin.com/mcp` | MCP endpoint (Streamable HTTP) |
| `scope` | `openid offline_access` | Scope requested during authorization; `offline_access` yields a refresh token so you stay signed in |
| `tokenFile` | `$DSH_HOME/mobbin-mcp/oauth.json` | Where tokens live |
| `callbackPort` | `14565` | Loopback port (falls back to a free port) |
| `autoAuthorize` | `false` | Start the browser flow at startup when no tokens exist |
| `openBrowser` | `true` | Open the authorization URL automatically |
| `toolCallTimeoutMs` | `60000` | Per-call timeout for Mobbin tools |

## Tools

The tool list comes from the Mobbin server and is registered as-is, using the same naming contract as DSH's built-in MCP client:

- prefix `mcp__<serverName>__`
- only `[A-Za-z0-9_-]` survives; over-long names are truncated with a 12-hex SHA-256 suffix

Typical capabilities (whatever the server actually exposes): natural-language screen search, browsing by app / platform / screen type, collection management.

## How images are handled

Mobbin results embed images. The plugin projects them once in `projectContent`:

- when the active model accepts image input (`inputModalities` includes `image`) and an attachment store is mounted, images are decoded, persisted as attachments, and the model receives real image blocks;
- otherwise each image degrades to a single explanatory text line, the raw payload stays available to programmatic callers, and the call still succeeds.

## Security

- Tokens stay on this machine, mode 0600, never logged;
- PKCE + loopback redirect — the plugin never sees or forwards your password;
- the plugin connects on startup only; no background polling;
- `autoAuthorize` is off by default so startup never surprises you with a browser window.

## Development

```bash
npm install
npm run check          # syntax check
node test/naming.test.mjs
node test/plugin.test.mjs
node test/oauth.test.mjs   # needs network; MOBBIN_OFFLINE=1 skips it
npm run login          # real OAuth authorization
```

Layout:

```
lib/index.js   cordis plugin entry: Config / apply / authorize tool
lib/oauth.js   discovery, DCR, PKCE, callback server, token store and refresh
lib/mobbin.js  MCP client bridge, tool naming, image projection
```

## License

Mobbin's MCP endpoint supports **OAuth 2.0 only** (no API key) — this is what the "Other" client in Mobbin's docs means. This plugin implements the whole flow with Node's built-in `fetch`:

- **Protected-resource discovery** — `https://api.mobbin.com/.well-known/oauth-protected-resource/mcp`
- **Authorization-server metadata** — `/.well-known/oauth-authorization-server`
- **Dynamic client registration (RFC 7591)** — a fresh loopback client per authorization
- **PKCE (S256) + local callback server** — `http://127.0.0.1:<port>/callback`
- **Token exchange and refresh** — tokens stored at `$DSH_HOME/mobbin-mcp/oauth.json` (mode 0600), refreshed 60 s before expiry

## Requirements

- DeepSeek Harness `>= 0.2.0`
- Node.js `>= 20`
- A **Mobbin Pro / Team / Enterprise** plan (Mobbin MCP is paid-plan only)

## Install

From GitHub:

```bash
dsh plugin --profile web add github:zhitiaojun/dsh-mobbin-mcp
```

From npm:

```bash
dsh plugin --profile web add dsh-mobbin-mcp
```

From a local checkout:

```bash
dsh plugin --profile web add .
```

## Authorizing

With no stored credentials the plugin registers a single tool:

`mcp__mobbin__authorize`

Ask the model to call it (or just say "log in to Mobbin"). It will:

1. start a loopback HTTP server for the OAuth redirect;
2. open the Mobbin authorization page in your browser (the full URL is also logged, for machines without a browser);
3. you sign in and approve;
4. the plugin exchanges the code, writes the tokens, and registers the real Mobbin tools immediately.

The authorize tool unregisters itself afterwards; later DSH starts read the stored tokens and connect quietly.

To let the plugin start the flow by itself at boot:

```yaml
config:
  autoAuthorize: true
```

You can also authorize outside DSH (same token file — handy for debugging):

```bash
npm run login
```

## Configuration

`cordis.patch.yml` keeps the minimal config; everything else is optional:

| Field | Default | Meaning |
| --- | --- | --- |
| `serverName` | `mobbin` | Prefix for public tool names (`mcp__mobbin__search_screens`) |
| `url` | `https://api.mobbin.com/mcp` | MCP endpoint (Streamable HTTP) |
| `scope` | `openid offline_access` | Scope requested during authorization; `offline_access` yields a refresh token so you stay signed in |
| `tokenFile` | `$DSH_HOME/mobbin-mcp/oauth.json` | Where tokens live |
| `callbackPort` | `14565` | Loopback port (falls back to a free port) |
| `autoAuthorize` | `false` | Start the browser flow at startup when no tokens exist |
| `openBrowser` | `true` | Open the authorization URL automatically |
| `toolCallTimeoutMs` | `60000` | Per-call timeout for Mobbin tools |

## Tools

The tool list comes from the Mobbin server and is registered as-is, using the same naming contract as DSH's built-in MCP client:

- prefix `mcp__<serverName>__`
- only `[A-Za-z0-9_-]` survives; over-long names are truncated with a 12-hex SHA-256 suffix

Typical capabilities (whatever the server actually exposes): natural-language screen search, browsing by app / platform / screen type, collection management.

## How images are handled

Mobbin results embed images. The plugin projects them once in `projectContent`:

- when the active model accepts image input (`inputModalities` includes `image`) and an attachment store is mounted, images are decoded, persisted as attachments, and the model receives real image blocks;
- otherwise each image degrades to a single explanatory text line, the raw payload stays available to programmatic callers, and the call still succeeds.

## Security

- Tokens stay on this machine, mode 0600, never logged;
- PKCE + loopback redirect — the plugin never sees or forwards your password;
- the plugin connects on startup only; no background polling;
- `autoAuthorize` is off by default so startup never surprises you with a browser window.

## Development

```bash
npm install
npm run check          # syntax check
node test/naming.test.mjs
node test/plugin.test.mjs
node test/oauth.test.mjs   # needs network; MOBBIN_OFFLINE=1 skips it
npm run login          # real OAuth authorization
```

Layout:

```
lib/index.js   cordis plugin entry: Config / apply / authorize tool
lib/oauth.js   discovery, DCR, PKCE, callback server, token store and refresh
lib/mobbin.js  MCP client bridge, tool naming, image projection
```

## License

MIT
