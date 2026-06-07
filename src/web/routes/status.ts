import { networkInterfaces } from 'node:os'
import { logger } from '../../logger.js'
import { json, readBody } from '../http-helpers.js'
import { WEB_HOST, DASHBOARD_PUBLIC_URL } from '../../config.js'
import { getSetting, setSetting } from '../../db.js'
import type { RouteContext } from './types.js'

// Origins the server always trusts (mirrors the base set built in web.ts). Shown
// in the Settings UI as read-only so the user understands what's covered before
// adding extras. Recomputed here rather than imported to avoid leaking the
// web.ts server closure across the route boundary.
function baseOrigins(port: number): string[] {
  const lan = (WEB_HOST === '0.0.0.0' || WEB_HOST === '::')
    ? Object.values(networkInterfaces())
        .flat()
        .filter((ni): ni is NonNullable<typeof ni> => !!ni && ni.family === 'IPv4' && !ni.internal)
        .map((ni) => `http://${ni.address}:${port}`)
    : []
  return [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    ...(WEB_HOST !== 'localhost' && WEB_HOST !== '127.0.0.1' && WEB_HOST !== '0.0.0.0' && WEB_HOST !== '::' ? [`http://${WEB_HOST}:${port}`] : []),
    ...lan,
    ...(DASHBOARD_PUBLIC_URL ? [DASHBOARD_PUBLIC_URL.replace(/\/$/, '')] : []),
  ]
}

// scheme://host(:port) with no path/query/fragment -- a CORS Origin header is
// exactly this shape, so anything else is a typo or an injection attempt.
const ORIGIN_RE = /^https?:\/\/[a-zA-Z0-9.\-]+(:\d{1,5})?$/

export async function tryHandleStatus(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/settings/origins' && method === 'GET') {
    const port = Number(url.port) || 3420
    const extra = getSetting('allowed_origins') || ''
    json(res, { base: baseOrigins(port), extra })
    return true
  }

  if (path === '/api/settings/origins' && method === 'POST') {
    const body = await readBody(req)
    let parsed: { extra?: unknown }
    try { parsed = JSON.parse(body.toString()) } catch { json(res, { error: 'Invalid JSON' }, 400); return true }

    const raw = typeof parsed.extra === 'string' ? parsed.extra : ''
    const origins = raw.split('\n').map(s => s.trim().replace(/\/$/, '')).filter(Boolean)
    const bad = origins.find(o => !ORIGIN_RE.test(o))
    if (bad) { json(res, { error: `Érvénytelen origin: ${bad}` }, 400); return true }

    // Store newline-joined and de-duplicated; web.ts reads this same key.
    setSetting('allowed_origins', [...new Set(origins)].join('\n'))
    json(res, { ok: true, extra: getSetting('allowed_origins') || '' })
    return true
  }

  if (path === '/api/status' && method === 'GET') {
    try {
      const rssResponse = await fetch('https://status.claude.com/history.rss', { signal: AbortSignal.timeout(10000) })
      const rssText = await rssResponse.text()

      const items: any[] = []
      const itemRegex = /<item>([\s\S]*?)<\/item>/g
      let match
      while ((match = itemRegex.exec(rssText)) !== null) {
        const itemXml = match[1]
        const title = itemXml.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() || ''
        const description = itemXml.match(/<description>([\s\S]*?)<\/description>/)?.[1]?.trim() || ''
        const pubDate = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() || ''
        const link = itemXml.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() || ''

        const cleanDesc = description
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&apos;/g, "'")
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

        let status = 'investigating'
        if (cleanDesc.toLowerCase().includes('resolved')) status = 'resolved'
        else if (cleanDesc.toLowerCase().includes('monitoring')) status = 'monitoring'
        else if (cleanDesc.toLowerCase().includes('identified')) status = 'identified'

        items.push({ title, description: cleanDesc, pubDate, link, status })
      }

      let overall = 'operational'
      const activeIncidents = items.filter(i => i.status !== 'resolved')
      if (activeIncidents.length > 0) overall = 'degraded'

      // Real per-service status from the Statuspage components API. The RSS feed
      // only carries incident history (no per-service state), so the dashboard
      // used to invent a hardcoded service list and substring-match incident
      // titles -- which left every tile permanently "operational". Fetch the
      // actual components so the grid reflects reality; on failure we return an
      // empty array and the UI shows an honest "no per-service data" note rather
      // than a fake green grid.
      let components: Array<{ name: string; status: string }> = []
      try {
        const compResp = await fetch('https://status.claude.com/api/v2/components.json', { signal: AbortSignal.timeout(10000) })
        if (compResp.ok) {
          const compData = await compResp.json() as { components?: Array<{ name: string; status: string; group?: boolean }> }
          components = (compData.components || [])
            .filter(c => !c.group) // drop group containers, keep leaf services
            .map(c => ({ name: c.name, status: c.status }))
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to fetch Claude status components')
      }

      json(res, { overall, components, incidents: items.slice(0, 15), fetchedAt: Date.now() })
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch Claude status')
      json(res, { overall: 'unknown', components: [], incidents: [], fetchedAt: Date.now(), error: 'Failed to fetch status' })
    }
    return true
  }

  return false
}
