import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
  type Configuration,
} from '@azure/msal-browser'
import { config } from './config'

let msal: PublicClientApplication | undefined
let tokenRequest: Promise<string | undefined> | undefined

export async function initAuth(): Promise<PublicClientApplication | undefined> {
  const cfg = config()
  if (!cfg.authEnabled) return undefined
  const msalConfig: Configuration = {
    auth: {
      clientId: cfg.spaClientId,
      authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
      redirectUri: window.location.origin,
      postLogoutRedirectUri: window.location.origin,
    },
    cache: { cacheLocation: 'localStorage' },
  }
  msal = new PublicClientApplication(msalConfig)
  await msal.initialize()
  const result = await msal.handleRedirectPromise()
  if (result?.account) msal.setActiveAccount(result.account)
  if (!msal.getActiveAccount()) {
    const [first] = msal.getAllAccounts()
    if (first) msal.setActiveAccount(first)
  }
  return msal
}

export function activeAccount(): AccountInfo | null {
  return msal?.getActiveAccount() ?? null
}

export async function login(): Promise<void> {
  await msal?.loginRedirect({ scopes: [config().apiScope] })
}

export async function logout(): Promise<void> {
  await msal?.logoutRedirect()
}

export async function getToken(): Promise<string | undefined> {
  if (!msal) return undefined
  tokenRequest ??= acquireToken(msal).finally(() => {
    tokenRequest = undefined
  })
  return tokenRequest
}

function isSilentAuthTimeout(err: unknown): boolean {
  if (!err || typeof err !== 'object' || !('errorCode' in err)) return false
  const code = String(err.errorCode)
  return code === 'timed_out' || code === 'block_iframe_reload'
}

async function acquireToken(client: PublicClientApplication): Promise<string | undefined> {
  const account = client.getActiveAccount()
  if (!account) {
    await client.loginRedirect({ scopes: [config().apiScope] })
    return undefined
  }
  const request = { scopes: [config().apiScope], account }
  try {
    return (await client.acquireTokenSilent(request)).accessToken
  } catch (err) {
    if (err instanceof InteractionRequiredAuthError || isSilentAuthTimeout(err)) {
      await client.acquireTokenRedirect(request)
      return undefined
    }
    throw err
  }
}
