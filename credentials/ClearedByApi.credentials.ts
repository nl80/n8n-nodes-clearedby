import type {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from 'n8n-workflow'

export class ClearedByApi implements ICredentialType {
  name = 'clearedByApi'

  displayName = 'ClearedBy API'

  // Full docs URL (community node). n8n's lint prefers a camelCase docs *slug*,
  // but a slug resolves to docs.n8n.io and 404s for a community credential, so
  // the miscased rule is disabled here in favour of a real, working link.
  // eslint-disable-next-line n8n-nodes-base/cred-class-field-documentation-url-miscased
  documentationUrl = 'https://clearedby.com'

  properties: INodeProperties[] = [
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      description: 'Your cb_live_… key from ClearedBy → Settings → Integrations → API keys. Keys can only request clearance, never decide.',
    },
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: 'https://app.clearedby.com',
      description: 'ClearedBy base URL. Override for a self-hosted or dev instance.',
    },
  ]

  // Inject the bearer token on every request the node makes.
  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: {
      headers: {
        Authorization: '=Bearer {{$credentials.apiKey}}',
      },
    },
  }

  // "Test" in the credential modal hits a read-only, key-authed endpoint.
  test: ICredentialTestRequest = {
    request: {
      baseURL: '={{$credentials.baseUrl}}/api/v1',
      url: '/policies',
    },
  }
}
