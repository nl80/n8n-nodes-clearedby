import { createHmac } from 'node:crypto'
import {
  NodeOperationError,
  type IDataObject,
  type IHookFunctions,
  type INodeType,
  type INodeTypeDescription,
  type IWebhookFunctions,
  type IWebhookResponseData,
} from 'n8n-workflow'

// ClearedBy → app.clearedby.com/api/v1. The credential's baseUrl is the origin.
const apiBase = (baseUrl: unknown): string =>
  String(baseUrl ?? 'https://app.clearedby.com').replace(/\/+$/, '') + '/api/v1'

// The "Decision received" trigger (CLE-30) — the two-flow / Zapier-style pattern.
// Rides the org-level webhook subscriptions (CLE-9), NOT the Gate node's per-item
// callback_url. On activation it registers one subscription; on deactivation it
// removes it. Inbound events are HMAC-verified before the workflow runs.
export class ClearedByTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'ClearedBy Trigger',
    name: 'clearedByTrigger',
    icon: 'file:clearedby.svg',
    group: ['trigger'],
    version: 1,
    subtitle: '=Decision received',
    description: 'Starts the workflow when ClearedBy clears, rejects, or expires an action',
    defaults: { name: 'ClearedBy Trigger' },
    inputs: [],
    outputs: ['main'],
    credentials: [{ name: 'clearedByApi', required: true }],
    webhooks: [
      {
        name: 'default',
        httpMethod: 'POST',
        responseMode: 'onReceived',
        path: 'webhook',
      },
    ],
    properties: [
      {
        displayName: 'Events',
        name: 'events',
        type: 'multiOptions',
        options: [
          { name: 'Cleared', value: 'decision.cleared' },
          { name: 'Rejected', value: 'decision.rejected' },
          { name: 'Expired', value: 'decision.expired' },
        ],
        default: ['decision.cleared', 'decision.rejected', 'decision.expired'],
        required: true,
        description: 'Which decision events start the workflow',
      },
      {
        displayName: 'Action Prefix',
        name: 'actionPrefix',
        type: 'string',
        default: '',
        placeholder: 'refund.',
        description: 'Only fire for actions starting with this prefix. Blank = all actions.',
      },
      {
        displayName: 'Policy',
        name: 'policy',
        type: 'string',
        default: '',
        description: 'Only fire for decisions judged by this policy name. Blank = all policies.',
      },
    ],
  }

  // Subscription lifecycle: n8n calls these as the workflow is activated/deactivated.
  webhookMethods = {
    default: {
      async checkExists(this: IHookFunctions): Promise<boolean> {
        const data = this.getWorkflowStaticData('node')
        return typeof data.subscriptionId === 'string'
      },

      async create(this: IHookFunctions): Promise<boolean> {
        const webhookUrl = this.getNodeWebhookUrl('default')
        if (!webhookUrl) {
          throw new NodeOperationError(this.getNode(), 'Could not resolve this trigger’s webhook URL')
        }
        const credentials = await this.getCredentials('clearedByApi')
        const events = this.getNodeParameter('events') as string[]
        const actionPrefix = (this.getNodeParameter('actionPrefix', '') as string).trim()
        const policy = (this.getNodeParameter('policy', '') as string).trim()
        const filters: IDataObject = {}
        if (actionPrefix) filters.action_prefix = actionPrefix
        if (policy) filters.policy = policy

        const res = (await this.helpers.httpRequestWithAuthentication.call(this, 'clearedByApi', {
          method: 'POST',
          url: `${apiBase(credentials.baseUrl)}/webhooks`,
          body: { url: webhookUrl, events, filters, source: 'n8n' },
          json: true,
        })) as { id?: string; secret?: string }
        if (!res.id) {
          throw new NodeOperationError(this.getNode(), 'ClearedBy did not return a subscription id')
        }
        const data = this.getWorkflowStaticData('node')
        data.subscriptionId = res.id
        data.secret = res.secret ?? '' // stored to verify inbound signatures
        return true
      },

      async delete(this: IHookFunctions): Promise<boolean> {
        const data = this.getWorkflowStaticData('node')
        const id = data.subscriptionId
        if (typeof id === 'string') {
          const credentials = await this.getCredentials('clearedByApi')
          try {
            await this.helpers.httpRequestWithAuthentication.call(this, 'clearedByApi', {
              method: 'DELETE',
              url: `${apiBase(credentials.baseUrl)}/webhooks/${id}`,
              json: true,
            })
          } catch {
            // Already removed server-side — fine; just clear local state.
          }
          delete data.subscriptionId
          delete data.secret
        }
        return true
      },
    },
  }

  // Inbound event from ClearedBy. Verify the HMAC over the EXACT raw bytes before
  // emitting, so a forged/replayed POST can't start the workflow.
  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const body = this.getBodyData() as IDataObject
    const headers = this.getHeaderData() as IDataObject
    const data = this.getWorkflowStaticData('node')
    const secret = typeof data.secret === 'string' ? data.secret : ''

    const req = this.getRequestObject() as unknown as { rawBody?: Buffer }
    const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(body)
    const provided = String(headers['x-clearedby-signature'] ?? '')
    const expected = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')

    if (!secret || provided.length === 0 || provided !== expected) {
      const res = this.getResponseObject()
      res.status(401).send('invalid signature')
      return { noWebhookResponse: true }
    }

    return { workflowData: [this.helpers.returnJsonArray([body])] }
  }
}
