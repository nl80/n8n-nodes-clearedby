import {
  NodeOperationError,
  type IDataObject,
  type IExecuteFunctions,
  type ILoadOptionsFunctions,
  type INodeExecutionData,
  type INodePropertyOptions,
  type INodeType,
  type INodeTypeDescription,
  type IWebhookFunctions,
  type IWebhookResponseData,
} from 'n8n-workflow'

// Wait "forever" — until ClearedBy POSTs the verdict to the resume URL. n8n
// resumes the execution the moment that callback lands, so the date just has to
// be far enough out that the SLA timeout (escalate/hold/reject) always wins.
const WAIT_FOREVER = new Date('2999-12-31T23:59:59.000Z')

const OUTPUT_CLEARED = 0
const OUTPUT_REJECTED = 1

// ClearedBy → app.clearedby.com/api/v1. The credential's baseUrl is the origin.
const apiBase = (baseUrl: unknown): string => String(baseUrl ?? 'https://app.clearedby.com').replace(/\/+$/, '') + '/api/v1'

interface GateResponse {
  id: string
  status: 'cleared' | 'rejected' | 'pending'
  shadow?: boolean
  would?: { verdict?: string; rule?: string }
  decided_by?: string
  rule?: string
  reason?: string | null
  sampled?: boolean
  attestation?: { seq?: number; hash?: string }
}

interface CallbackBody {
  id?: string
  status?: 'cleared' | 'rejected' | 'sent_back' | 'expired'
  decided_by?: string
  reason?: string | null
  attestation?: { seq?: number; hash?: string }
}

// What we stash (workflow static data, keyed by gate id) while an item is parked,
// so the resume can rebuild a full output row — the original item + the verdict.
interface ParkedItem {
  item: IDataObject
  rule: string | null
  onReject: string
}

/** A clean, predictable `clearedby` block merged onto the emitted item. */
function verdictBlock(v: {
  id: string
  status: string
  decided_by?: string | null
  rule?: string | null
  reason?: string | null
  hash?: string | null
  shadow?: boolean
  sampled?: boolean
}): IDataObject {
  return {
    id: v.id,
    status: v.status,
    decided_by: v.decided_by ?? null,
    rule: v.rule ?? null,
    reason: v.reason ?? null,
    hash: v.hash ?? null,
    shadow: v.shadow ?? false,
    sampled: v.sampled ?? false,
  }
}

export class ClearedByGate implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'ClearedBy Gate',
    name: 'clearedByGate',
    icon: 'file:clearedby.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{ $parameter["action"] }}',
    description: 'Gate an action behind policy + human approval before the workflow proceeds',
    defaults: { name: 'ClearedBy Gate' },
    inputs: ['main'],
    // Two outputs: Cleared (1st) and Rejected / Expired (2nd). The lint rule's
    // autofix wrongly collapses multi-output nodes to a single 'main', so it is
    // disabled on this line — the two outputs are intentional (see On Reject).
    // eslint-disable-next-line n8n-nodes-base/node-class-description-outputs-wrong
    outputs: ['main', 'main'],
    outputNames: ['Cleared', 'Rejected / Expired'],
    credentials: [{ name: 'clearedByApi', required: true }],
    // Resume webhook (restartWebhook): ClearedBy POSTs the decision here when a
    // held item is decided, resuming a parked execution.
    webhooks: [
      {
        name: 'default',
        httpMethod: 'POST',
        responseMode: 'onReceived',
        responseData: 'noData',
        path: '={{ $nodeId }}',
        restartWebhook: true,
      },
    ],
    properties: [
      {
        displayName: 'Action',
        name: 'action',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'refund.create',
        description: 'The action to gate. Your ClearedBy policy matches rules against this.',
      },
      {
        displayName: 'Payload',
        name: 'payloadMode',
        type: 'options',
        options: [
          { name: 'All Item JSON', value: 'all', description: 'Send the whole incoming item as the action params' },
          { name: 'Selected Fields', value: 'fields', description: 'Send only the named fields' },
        ],
        default: 'all',
        description: 'What to send as the action params (your policy reads these, e.g. amount)',
      },
      {
        displayName: 'Fields',
        name: 'fields',
        type: 'string',
        default: '',
        placeholder: 'amount, order, currency',
        displayOptions: { show: { payloadMode: ['fields'] } },
        description: 'Comma-separated item fields to send as params',
      },
      {
        displayName: 'Policy Name or ID',
        name: 'policy',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'getPolicies' },
        default: '',
        description: 'Which policy to evaluate against. Leave on “Org default” to use the org’s default policy. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
      },
      {
        displayName: 'Mode',
        name: 'mode',
        type: 'options',
        options: [
          { name: 'Shadow (Never Blocks)', value: 'shadow', description: 'Records what would happen; the item always continues on “Cleared”' },
          { name: 'Enforce (Blocks on Review)', value: 'enforce', description: 'A “review” verdict parks the workflow until a human decides' },
        ],
        default: 'shadow',
        description: 'Shadow is the safe default while you tune a policy — nothing is ever blocked',
      },
      {
        displayName: 'Summary',
        name: 'summary',
        type: 'string',
        default: '',
        description: 'Optional one-line context shown to the human reviewer',
      },
      {
        displayName: 'Timeout Override (Seconds)',
        name: 'timeoutOverride',
        type: 'number',
        default: 0,
        description: 'Override the policy’s review deadline for this call. 0 = use the policy default.',
      },
      {
        displayName: 'On Reject',
        name: 'onReject',
        type: 'options',
        options: [
          { name: 'Route to 2nd Output', value: 'output', description: 'Send rejected/expired items to the “Rejected / Expired” output' },
          { name: 'Stop With Error', value: 'error', description: 'Throw, so the workflow stops on a rejection' },
          { name: 'Continue on 1st Output (Cleared: False)', value: 'continue', description: 'Keep everything on “Cleared” but flag clearedby.cleared = false' },
        ],
        default: 'output',
        description: 'What to do when policy or a reviewer rejects the action',
      },
    ],
  }

  methods = {
    loadOptions: {
      // Populate the Policy dropdown from GET /v1/policies. Failure is non-fatal:
      // we always offer “Org default”, so the node stays usable before creds exist.
      async getPolicies(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const options: INodePropertyOptions[] = [{ name: '— Org Default —', value: '' }]
        try {
          const credentials = await this.getCredentials('clearedByApi')
          const res = (await this.helpers.httpRequestWithAuthentication.call(this, 'clearedByApi', {
            method: 'GET',
            url: `${apiBase(credentials.baseUrl)}/policies`,
            json: true,
          })) as IDataObject | unknown[]
          const list = Array.isArray(res) ? res : ((res as IDataObject).policies as unknown[] | undefined) ?? []
          for (const p of list) {
            const name = typeof p === 'string' ? p : (p as IDataObject).name
            if (typeof name === 'string' && name.length > 0) options.push({ name, value: name })
          }
        } catch {
          // ignore — leave just the “Org default” option
        }
        return options
      },
    },
  }

  // Resume path: ClearedBy POSTed the decision for a parked item. Map it to the
  // right output and merge in the original item we stashed at park time.
  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const body = (this.getBodyData() ?? {}) as CallbackBody
    const status = body.status ?? 'expired'
    const id = body.id ?? ''

    const staticData = this.getWorkflowStaticData('node') as { parked?: Record<string, ParkedItem> }
    const parked = staticData.parked ?? {}
    const stashed = id in parked ? parked[id] : undefined
    if (stashed !== undefined) delete parked[id]
    staticData.parked = parked

    const clearedby = verdictBlock({
      id,
      status,
      decided_by: body.decided_by ?? null,
      rule: stashed?.rule ?? null,
      reason: body.reason ?? null,
      hash: body.attestation?.hash ?? null,
    })

    const json: IDataObject = { ...(stashed?.item ?? {}), clearedby }

    if (status === 'cleared') {
      return { workflowData: [[{ json }], []] }
    }
    // rejected / expired / sent_back → 2nd output (or 1st with cleared:false)
    if (stashed?.onReject === 'continue') {
      ;(json.clearedby as IDataObject).cleared = false
      return { workflowData: [[{ json }], []] }
    }
    return { workflowData: [[], [{ json }]] }
  }

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData()
    const credentials = await this.getCredentials('clearedByApi')
    const base = apiBase(credentials.baseUrl)

    const cleared: INodeExecutionData[] = []
    const rejected: INodeExecutionData[] = []
    const toPark: Record<string, ParkedItem> = {}

    for (let i = 0; i < items.length; i++) {
      const action = this.getNodeParameter('action', i) as string
      const payloadMode = this.getNodeParameter('payloadMode', i) as string
      const mode = this.getNodeParameter('mode', i) as string
      const policy = this.getNodeParameter('policy', i, '') as string
      const summary = this.getNodeParameter('summary', i, '') as string
      const timeoutOverride = this.getNodeParameter('timeoutOverride', i, 0) as number
      const onReject = this.getNodeParameter('onReject', i, 'output') as string
      const itemJson = items[i]?.json ?? {}

      let params: IDataObject
      if (payloadMode === 'fields') {
        const fields = (this.getNodeParameter('fields', i, '') as string).split(',').map((f) => f.trim()).filter(Boolean)
        params = {}
        for (const f of fields) params[f] = itemJson[f]
      } else {
        params = { ...itemJson }
      }

      // Resume URL the held verdict will be POSTed back to (enforce only).
      // `$execution.resumeUrl` is provided because this node declares a
      // restartWebhook; ClearedBy calls it when the held item is decided.
      const resumeUrl =
        mode === 'enforce'
          ? (this.evaluateExpression('{{ $execution.resumeUrl }}', i) as string | undefined)
          : undefined

      const body: IDataObject = {
        action,
        params,
        mode,
        ...(summary ? { context: { summary } } : {}),
        ...(policy ? { policy } : {}),
        ...(timeoutOverride > 0 ? { timeout: timeoutOverride } : {}),
        ...(resumeUrl ? { callback_url: resumeUrl } : {}),
      }

      let res: GateResponse
      try {
        res = (await this.helpers.httpRequestWithAuthentication.call(this, 'clearedByApi', {
          method: 'POST',
          url: `${base}/gate`,
          body,
          json: true,
        })) as GateResponse
      } catch (error) {
        const err = error as { response?: { body?: { error?: { message?: string; hint?: string } } }; message?: string }
        const apiErr = err.response?.body?.error
        throw new NodeOperationError(this.getNode(), apiErr?.message ?? err.message ?? 'ClearedBy gate request failed', {
          description: apiErr?.hint,
          itemIndex: i,
        })
      }

      const clearedby = verdictBlock({
        id: res.id,
        status: res.status,
        decided_by: res.decided_by ?? null,
        rule: res.rule ?? res.would?.rule ?? null,
        reason: res.reason ?? null,
        hash: res.attestation?.hash ?? null,
        shadow: res.shadow,
        sampled: res.sampled,
      })

      if (res.status === 'cleared') {
        cleared.push({ json: { ...itemJson, clearedby }, pairedItem: { item: i } })
      } else if (res.status === 'rejected') {
        if (onReject === 'error') {
          throw new NodeOperationError(this.getNode(), `ClearedBy rejected “${action}”${res.reason ? `: ${res.reason}` : ''}`, { itemIndex: i })
        }
        if (onReject === 'continue') {
          cleared.push({ json: { ...itemJson, clearedby: { ...clearedby, cleared: false } }, pairedItem: { item: i } })
        } else {
          rejected.push({ json: { ...itemJson, clearedby }, pairedItem: { item: i } })
        }
      } else {
        // pending — park this item; the resume webhook completes it.
        toPark[res.id] = { item: itemJson, rule: (clearedby.rule as string | null) ?? null, onReject }
      }
    }

    if (Object.keys(toPark).length > 0) {
      // Stash parked items so webhook() can rebuild full rows on resume, and keep
      // any already-instant rows to replay alongside them.
      const staticData = this.getWorkflowStaticData('node') as { parked?: Record<string, ParkedItem> }
      staticData.parked = { ...(staticData.parked ?? {}), ...toPark }
      // NOTE: one parked item per execution resumes cleanly (n8n continues on the
      // first callback). For multiple concurrent holds, gate one item per
      // execution (e.g. Split In Batches). See README.
      await this.putExecutionToWait(WAIT_FOREVER)
    }

    return [cleared, rejected]
  }
}
