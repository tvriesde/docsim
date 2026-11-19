import { Network } from 'lucide-react'
import { Button } from '@/components/ui'
import { login } from '@/lib/auth'

export function LoginScreen() {
  return (
    <div className="bg-grid flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-panel p-8 text-center shadow-2xl">
        <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-accent-2 text-white">
          <Network className="size-6" />
        </div>
        <h1 className="text-lg font-semibold">DocSim</h1>
        <p className="mt-1 text-sm text-muted">Explore clusters of similar documents.</p>
        <Button className="mt-6 w-full" onClick={() => void login()}>
          Sign in with Microsoft
        </Button>
      </div>
    </div>
  )
}
