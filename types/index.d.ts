export type ModelName = 'haiku' | 'sonnet' | 'opus'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Mode = 'default' | 'acceptEdits' | 'plan' | 'auto'

export type Advice = {
  model: ModelName
  effort: Effort
  mode: Mode
  fast: boolean
  confidence: number
  reason: string
  source: 'heuristic' | 'haiku'
}

export type Choice = {
  model: ModelName
  effort: Effort
  mode: Mode
  fast: boolean
  isPersistent: boolean
}

export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type TurnRecord = {
  prompt: string
  model: string
  tokens: Tokens
  usd: number
  tools: Record<string, number>
}

export type ToolSpend = { calls: number; tokens: number }

export type Ledger = {
  byModel: Record<string, Tokens>
  byTool: Record<string, ToolSpend>
  advisor: Tokens
  turns: TurnRecord[]
  // $ saved by running cheaper than the chat's own model, and $ that a shown cheaper advice could have saved but was not applied.
  saved?: number
  missed?: number
  // The same, summed over every chat (kept in $.store), so a new chat does not start from nothing.
  life?: { saved: number; missed: number }
  // Calibration of $ against subscription limits: API-priced $ of measured turns and the limit % they moved.
  calUsd?: number
  cal5h?: number
  cal7d?: number
}

export type Limits = {
  usd: number | null
  context: number | null
  windows: { kind: string; percentUsed: number; resetsAt?: string }[]
}

declare module 'claude-code' {
  interface PluginState {
    'model-advisor': {
      advice: Advice | null
      choice: Choice | null
      isEditing: boolean
      isHidden: boolean
      ledger: Ledger
      limits: Limits
    }
  }
}
