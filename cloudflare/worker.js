import { API_ROUTES } from '../src/lib/apiRoutes'
import {
  authorizePrivateRequest,
  PRIVATE_AUTH_HEADER,
} from '../src/lib/privateAccess'

const WEBHOOK_PATH = '/api/billing/webhook'
const SHORTCUT_IMAGE_PATH = '/api/shortcut/image'
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const IMAGE_ACCEPT = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
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

  let changed = false
  const image_urls = payload.image_urls.map((value) => {
    if (typeof value !== 'string') return value
    const raw = rawImageUrlFromProxy(value, origin)
    if (!raw) return value
    changed = true
    return raw
  })
  if (!changed) return response

  const headers = new Headers(response.headers)
  headers.delete('content-length')
  return new Response(JSON.stringify({ ...payload, image_urls }), {
    status: response.status,
    headers,
  })
}

async function handleShortcutImage(request, env) {
  const auth = await authorizePrivateRequest(request, env)
  if (!auth.ok) return unauthorizedResponse()

  let body
  try {
    body = await request.json()
  } catch {
    return Response.json({ success: false, error: '请求必须是 JSON 格式。' }, { status: 400 })
  }

  const imageUrl = typeof body?.url === 'string' ? body.url.trim() : ''
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

  const upstream = await fetch(target, {
    headers: {
      Accept: IMAGE_ACCEPT,
      Referer: 'https://www.instagram.com/',
      'User-Agent': BROWSER_UA,
    },
    redirect: 'follow',
  })
  if (!upstream.ok) {
    return Response.json(
      { success: false, error: `Instagram 图片请求失败：${upstream.status}` },
      { status: upstream.status },
    )
  }

  const headers = new Headers({
    'Content-Type': upstream.headers.get('content-type') || 'image/jpeg',
    'Cache-Control': 'no-store',
    'Content-Disposition': 'inline; filename="instagram-image.jpg"',
  })
  const contentLength = upstream.headers.get('content-length')
  if (contentLength) headers.set('Content-Length', contentLength)
  return new Response(upstream.body, { status: 200, headers })
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
      return handleShortcutImage(request, env)
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
