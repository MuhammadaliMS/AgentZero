'use client'

import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { IntegrationWithStatus } from '@/types/integrations'

export function ApiKeyForm({
  integration,
  open,
  onClose,
  onConnected,
}: {
  integration: IntegrationWithStatus
  open: boolean
  onClose: () => void
  onConnected: () => void
}) {
  const [credentials, setCredentials] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Determine which fields to show based on integration key
  const fields = getFieldsForIntegration(integration.key)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      const response = await fetch(`/api/integrations/${integration.key}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials),
      })

      const data = await response.json()
      if (!response.ok) {
        setError(data.error)
        setLoading(false)
        return
      }

      onConnected()
    } catch (e) {
      setError((e as Error).message)
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect {integration.name}</DialogTitle>
          <DialogDescription>
            {integration.instructions?.[0]?.description || `Enter your ${integration.name} credentials to connect.`}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {fields.map(field => (
            <div key={field.key} className="space-y-2">
              <Label htmlFor={field.key}>{field.label}</Label>
              <Input
                id={field.key}
                type={field.type || 'text'}
                placeholder={field.placeholder}
                value={credentials[field.key] || ''}
                onChange={e => setCredentials(prev => ({ ...prev, [field.key]: e.target.value }))}
                required
              />
            </div>
          ))}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? 'Connecting...' : 'Connect'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function getFieldsForIntegration(key: string) {
  switch (key) {
    case 'vanta':
      return [
        { key: 'client_id', label: 'Client ID', placeholder: 'Enter your Vanta Client ID' },
        { key: 'client_secret', label: 'Client Secret', type: 'password', placeholder: 'Enter your Vanta Client Secret' },
      ]
    case 'crowdstrike':
      return [
        { key: 'client_id', label: 'Client ID', placeholder: 'Enter your CrowdStrike Client ID' },
        { key: 'client_secret', label: 'Client Secret', type: 'password', placeholder: 'Enter your CrowdStrike Client Secret' },
        { key: 'base_url', label: 'API Base URL (optional)', placeholder: 'https://api.crowdstrike.com' },
      ]
    case 'qualys':
      return [
        { key: 'api_url', label: 'API URL', placeholder: 'https://qualysapi.qualys.com' },
        { key: 'username', label: 'Username', placeholder: 'Enter your Qualys username' },
        { key: 'password', label: 'Password', type: 'password', placeholder: 'Enter your Qualys password' },
      ]
    default:
      return [
        { key: 'api_key', label: 'API Key', type: 'password', placeholder: 'Enter your API key' },
      ]
  }
}
