import { API_ROUTES } from '../src/lib/apiRoutes'
import {
  authorizePrivateRequest,
  PRIVATE_AUTH_HEADER,
} from '../src/lib/privateAccess'

const WEBHOOK_PATH = '/api/billing/webhook'
const SHORTCUT_IMAGE_PATH = '/api/shortcut/image'
const PROTECTED_API_PATHS = new Set([
  '/api/download',
  '/api/shortcut/resolve',
  '/api/images',
  '/api/slideshow',
  '/api/tiktok',
  '/api/youtube',
  '/api/image',
  '/api/video',
  '/api/audio',
  '/api/thumb',
])
const RESOLVE_PATHS = new Set(['/api/download', '/api/shortcut/resolve'])
const RESOLVE_WINDOW_MS = 60_000
const RESOLVE_MAX_PER_WINDOW = 30
const resolveWindows = new Map()

function rateLimitResolve(request, kind) {
  const now = Date.now()
  const address =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  const key = `${kind}:${address}`
  const current = resolveWindows.get(key)
  const next =
    current && current.resetAt > now
      ? { count: current.count + 1, resetAt: current.resetAt }
      : { count: 1, resetAt: now + RESOLVE_WINDOW_MS }
  resolveWindows.set(key, next)

  if (resolveWindows.size > 1000) {
    for (const [entryKey, value] of resolveWindows) {
      if (value.resetAt <= now || resolveWindows.size > 800) {
        resolveWindows.delete(entryKey)
      }
    }
  }

  if (next.count <= RESOLVE_MAX_PER_WINDOW) return null
  return Math.max(1, Math.ceil((next.resetAt - now) / 1000))
}

function isWorkersDev(hostname) {
  return hostname.endsWith('.workers.dev')
}

function methodMatches(requestMethod, routeMethod) {
  if (requestMethod === routeMethod) return true
  return routeMethod === 'GET' && requestMethod === 'HEAD'
}

function methodNotAllowed(routeMethod) {
  const allow = routeMethod === 'GET' ? 'GET, HEAD' : routeMethod
  return Response.json(
    { success: false, error: `Method not allowed. Use ${allow}.` },
    { status: 405, headers: { Allow: allow } },
  )
}

function unauthorizedResponse() {
  return Response.json(
    { success: false, error: '未登录或 API Key 无效，已拒绝本次请求。' },
    {
      status: 401,
      headers: {
        'Cache-Control': 'no-store',
        'WWW-Authenticate': 'Bearer realm="private downloader"',
      },
    },
  )
}

function hexEncode(value) {
  return [...new TextEncoder().encode(value)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function hexDecode(value) {
  const normalized = value.trim()
  if (!/^(?:[0-9a-f]{2})+$/i.test(normalized)) return null
  const bytes = new Uint8Array(normalized.length / 2)
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16)
  }
  return new TextDecoder().decode(bytes)
}

function rawImageUrlFromProxy(value, origin) {
  try {
    const proxy = new URL(value, origin)
    if (proxy.pathname !== '/api/image') return null
    const raw = proxy.searchParams.get('url')
    return raw && /^https?:\/\//i.test(raw) ? raw : null
  } catch {
    return null
  }
}

async function rewriteShortcutImageUrls(response, origin) {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    return response
  }

  let payload
  try {
    payload = await response.clone().json()
  } catch {
    return response
  }
  if (
    !payload?.success ||
    payload.platform !== 'instagram' ||
    !Array.isArray(payload.image_urls)
  ) {
    return response
  }

  const image_tokens = payload.image_urls
    .map((value) => (typeof value === 'string' ? rawImageUrlFromProxy(value, origin) : null))
    .filter(Boolean)
    .map(hexEncode)

  if (image_tokens.length === 0) return response

  const headers = new Headers(response.headers)
  headers.delete('content-length')
  return new Response(JSON.stringify({ ...payload, image_tokens }), {
    status: response.status,
    headers,
  })
}

async function handleShortcutImage(request, ctx, env) {
  const auth = await authorizePrivateRequest(request, env)
  if (!auth.ok) return unauthorizedResponse()

  let body
  try {
    body = await request.json()
  } catch {
    return Response.json({ success: false, error: '请求必须是 JSON 格式。' }, { status: 400 })
  }

  const token = typeof body?.token === 'string' ? body.token : ''
  const imageUrl = hexDecode(token)
  if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) {
    return Response.json({ success: false, error: '图片令牌无效。' }, { status: 400 })
  }

  let target
  try {
    target = new URL(imageUrl)
  } catch {
    return Response.json({ success: false, error: '图片地址无效。' }, { status: 400 })
  }

  const instagramCdn =
    target.hostname.endsWith('cdninstagram.com') || target.hostname.endsWith('fbcdn.net')
  if (!instagramCdn) {
    return Response.json({ success: false, error: '只允许 Instagram 图片地址。' }, { status: 400 })
  }

  const proxyUrl = new URL('/api/image', request.url)
  proxyUrl.searchParams.set('url', target.toString())
  const headers = new Headers(request.headers)
  headers.delete(PRIVATE_AUTH_HEADER)
  headers.set(PRIVATE_AUTH_HEADER, auth.kind || 'api')
  const proxyRequest = new Request(proxyUrl, { method: 'GET', headers })
  return API_ROUTES['/api/image'].handler(proxyRequest, ctx, env)
}

const worker = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    const canonicalOrigin = String(env.CANONICAL_ORIGIN || '').replace(/\/$/, '')
    if (
      canonicalOrigin &&
      isWorkersDev(url.hostname) &&
      url.pathname !== WEBHOOK_PATH
    ) {
      return Response.redirect(`${canonicalOrigin}${url.pathname}${url.search}`, 301)
    }

    if (url.pathname === SHORTCUT_IMAGE_PATH) {
      if (!methodMatches(request.method, 'POST')) return methodNotAllowed('POST')
      return handleShortcutImage(request, ctx, env)
    }

    const route = API_ROUTES[url.pathname]
    if (route) {
      if (!methodMatches(request.method, route.method)) {
        return methodNotAllowed(route.method)
      }

      if (PROTECTED_API_PATHS.has(url.pathname)) {
        const auth = await authorizePrivateRequest(request, env)
        if (!auth.ok) return unauthorizedResponse()

        if (RESOLVE_PATHS.has(url.pathname)) {
          const retryAfter = rateLimitResolve(request, auth.kind || 'web')
          if (retryAfter) {
            return Response.json(
              { success: false, error: '解析请求过于频繁，请稍后再试。' },
              {
                status: 429,
                headers: {
                  'Cache-Control': 'no-store',
                  'Retry-After': String(retryAfter),
                },
              },
            )
          }
        }

        const headers = new Headers(request.headers)
        headers.delete(PRIVATE_AUTH_HEADER)
        headers.set(PRIVATE_AUTH_HEADER, auth.kind || 'web')
        request = new Request(request, { headers })
      }

      const response = await route.handler(request, ctx, env)
      return url.pathname === '/api/shortcut/resolve'
        ? rewriteShortcutImageUrls(response, url.origin)
        : response
    }

    return env.ASSETS.fetch(request)
  },
}

export default worker
