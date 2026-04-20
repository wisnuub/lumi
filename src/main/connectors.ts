import https from 'https'
import http from 'http'

export interface ConnectorResult {
  title:   string
  url?:    string
  snippet: string
  source:  string
}

// ─── Shared fetch ─────────────────────────────────────────────────────────────

function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, {
      headers: { 'User-Agent': 'local-ai/1.0 (educational)', ...headers },
      timeout: 8000,
    }, res => {
      // follow up to 3 redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchText(res.headers.location, headers).then(resolve).catch(reject)
        return
      }
      let data = ''
      res.setEncoding('utf-8')
      res.on('data', (c: string) => { data += c })
      res.on('end', () => resolve(data))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

function fetchJson<T = any>(url: string, headers: Record<string, string> = {}): Promise<T> {
  return fetchText(url, { 'Accept': 'application/json', ...headers }).then(t => JSON.parse(t))
}

// ─── Web search — DuckDuckGo ──────────────────────────────────────────────────

export async function webSearch(query: string): Promise<ConnectorResult[]> {
  const results: ConnectorResult[] = []

  try {
    // 1. Instant answer API
    const ia = await fetchJson(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`
    )
    if (ia.AbstractText) {
      results.push({ title: ia.Heading || 'Instant Answer', url: ia.AbstractURL, snippet: ia.AbstractText, source: 'web' })
    }
    for (const r of (ia.RelatedTopics || []).slice(0, 3)) {
      if (r.Text && r.FirstURL) {
        results.push({ title: r.Text.split(' - ')[0] || 'Related', url: r.FirstURL, snippet: r.Text, source: 'web' })
      }
    }
  } catch { /* non-fatal */ }

  // 2. Lite HTML results
  try {
    const html = await fetchText(
      `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
      { 'Accept-Language': 'en-US,en;q=0.9' }
    )
    // Extract result links + snippets from DDG lite table rows
    const linkRe    = /<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/g
    const snippetRe = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g
    const links:    [string, string][] = []
    const snippets: string[] = []

    let m: RegExpExecArray | null
    while ((m = linkRe.exec(html)) !== null) {
      const href = m[1]; const text = m[2].trim()
      if (href.startsWith('//duckduckgo.com/l/') || href.startsWith('http')) {
        // Decode DDG redirect URLs
        const realUrl = href.includes('uddg=')
          ? decodeURIComponent(href.split('uddg=')[1].split('&')[0])
          : href.replace(/^\/\//, 'https://')
        if (realUrl.startsWith('http') && !realUrl.includes('duckduckgo.com')) {
          links.push([text, realUrl])
        }
      }
    }
    while ((m = snippetRe.exec(html)) !== null) {
      snippets.push(m[1].replace(/<[^>]+>/g, '').trim())
    }

    for (let i = 0; i < Math.min(links.length, 4); i++) {
      if (results.length >= 6) break
      results.push({ title: links[i][0], url: links[i][1], snippet: snippets[i] || '', source: 'web' })
    }
  } catch { /* non-fatal */ }

  return results.slice(0, 6)
}

// ─── Wikipedia ────────────────────────────────────────────────────────────────

export async function wikiSearch(query: string): Promise<ConnectorResult[]> {
  const results: ConnectorResult[] = []
  try {
    const search = await fetchJson(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=4&format=json`
    )
    const titles: string[] = (search?.query?.search || []).map((r: any) => r.title)

    await Promise.allSettled(titles.slice(0, 3).map(async title => {
      const summary = await fetchJson(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`
      )
      if (summary?.extract) {
        results.push({
          title:   summary.title,
          url:     summary.content_urls?.desktop?.page,
          snippet: summary.extract.slice(0, 400),
          source:  'wikipedia',
        })
      }
    }))
  } catch { /* non-fatal */ }
  return results
}

// ─── GitHub ───────────────────────────────────────────────────────────────────

export async function githubSearch(query: string): Promise<ConnectorResult[]> {
  const results: ConnectorResult[] = []
  try {
    const data = await fetchJson(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=5`,
      { 'Accept': 'application/vnd.github+json' }
    )
    for (const r of (data.items || []).slice(0, 5)) {
      results.push({
        title:   `${r.full_name} ★${r.stargazers_count.toLocaleString()}`,
        url:     r.html_url,
        snippet: r.description || 'No description.',
        source:  'github',
      })
    }
  } catch { /* non-fatal */ }
  return results
}

// ─── npm ─────────────────────────────────────────────────────────────────────

export async function npmSearch(query: string): Promise<ConnectorResult[]> {
  const results: ConnectorResult[] = []
  try {
    const data = await fetchJson(
      `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=5`
    )
    for (const obj of (data.objects || []).slice(0, 5)) {
      const p = obj.package
      results.push({
        title:   `${p.name}@${p.version}`,
        url:     `https://www.npmjs.com/package/${p.name}`,
        snippet: p.description || 'No description.',
        source:  'npm',
      })
    }
  } catch { /* non-fatal */ }
  return results
}

// ─── Stack Overflow ───────────────────────────────────────────────────────────

export async function stackSearch(query: string): Promise<ConnectorResult[]> {
  const results: ConnectorResult[] = []
  try {
    const data = await fetchJson(
      `https://api.stackexchange.com/2.3/search/advanced?q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=5&filter=default`
    )
    for (const item of (data.items || []).slice(0, 5)) {
      results.push({
        title:   item.title.replace(/&amp;/g, '&').replace(/&#39;/g, "'"),
        url:     item.link,
        snippet: `${item.is_answered ? '✓ Answered' : 'Unanswered'} · ${item.answer_count} answers · ${item.score} votes`,
        source:  'stackoverflow',
      })
    }
  } catch { /* non-fatal */ }
  return results
}

// ─── HuggingFace ──────────────────────────────────────────────────────────────

export async function hfSearch(query: string): Promise<ConnectorResult[]> {
  const results: ConnectorResult[] = []
  try {
    const [models, papers] = await Promise.allSettled([
      fetchJson(`https://huggingface.co/api/models?search=${encodeURIComponent(query)}&limit=3&sort=downloads`),
      fetchJson(`https://huggingface.co/api/papers?q=${encodeURIComponent(query)}&limit=3`),
    ])

    if (models.status === 'fulfilled') {
      for (const m of models.value.slice(0, 3)) {
        results.push({ title: m.id, url: `https://huggingface.co/${m.id}`, snippet: m.cardData?.language?.join(', ') || `↓ ${m.downloads?.toLocaleString()} downloads`, source: 'huggingface' })
      }
    }
    if (papers.status === 'fulfilled') {
      for (const p of (papers.value || []).slice(0, 2)) {
        results.push({ title: p.title, url: `https://huggingface.co/papers/${p.id}`, snippet: (p.abstract || '').slice(0, 300), source: 'huggingface' })
      }
    }
  } catch { /* non-fatal */ }
  return results
}

// ─── Connector registry ───────────────────────────────────────────────────────

export const CONNECTOR_FNS: Record<string, (q: string) => Promise<ConnectorResult[]>> = {
  web:          webSearch,
  wikipedia:    wikiSearch,
  github:       githubSearch,
  npm:          npmSearch,
  stackoverflow: stackSearch,
  huggingface:  hfSearch,
}

export async function runConnectors(
  connectorIds: string[],
  query: string
): Promise<Record<string, ConnectorResult[]>> {
  const out: Record<string, ConnectorResult[]> = {}
  await Promise.allSettled(
    connectorIds.map(async id => {
      const fn = CONNECTOR_FNS[id]
      if (fn) out[id] = await fn(query)
    })
  )
  return out
}
