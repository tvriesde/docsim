export interface AppConfig {
  authEnabled: boolean
  tenantId: string
  spaClientId: string
  apiScope: string
  apiBaseUrl: string
}

const DEFAULTS: AppConfig = { authEnabled: false, tenantId: '', spaClientId: '', apiScope: '', apiBaseUrl: '' }

let current: AppConfig = DEFAULTS

/** Runtime configuration written at deploy time to /config.json; missing file = local dev without auth. */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const res = await fetch('/config.json', { cache: 'no-store' })
    if (res.ok && res.headers.get('content-type')?.includes('json')) {
      current = { ...DEFAULTS, ...((await res.json()) as Partial<AppConfig>) }
    }
  } catch {
    // keep defaults
  }
  current.apiBaseUrl = current.apiBaseUrl.replace(/\/+$/, '')
  return current
}

export function config(): AppConfig {
  return current
}
