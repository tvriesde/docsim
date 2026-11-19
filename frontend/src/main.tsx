import { TooltipProvider } from '@radix-ui/react-tooltip'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { activeAccount, initAuth } from './lib/auth'
import { loadConfig } from './lib/config'
import { LoginScreen } from './pages/Login'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 5_000 } },
})

async function start() {
  const root = createRoot(document.getElementById('root')!)
  const cfg = await loadConfig()
  try {
    await initAuth()
  } catch (err) {
    console.error('auth init failed', err)
  }
  const needsLogin = cfg.authEnabled && !activeAccount()
  root.render(
    <StrictMode>
      {needsLogin ? (
        <LoginScreen />
      ) : (
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </TooltipProvider>
        </QueryClientProvider>
      )}
    </StrictMode>,
  )
}

void start()
