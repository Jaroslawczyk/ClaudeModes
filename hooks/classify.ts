import type { Advice, Effort, Mode, ModelName } from '../types'

type Rule = {
  words: RegExp
  model: ModelName
  effort: Effort
  mode: Mode
  weight: number
  reason: string
}

// Ordered from cheapest to most demanding; the strongest match wins.
const RULES: Rule[] = [
  {
    words: /^\s*(привет|здравствуй|спасибо|ок|hi|hello|thanks)\b|\b(what is|what's|explain|why|how does|translate|summari[sz]e|rename|typo|format)\b|что такое|объясни|почему|как работает|переведи|перевод|кратко|опечатк|переимен|отформатируй/i,
    model: 'haiku',
    effort: 'low',
    mode: 'default',
    weight: 1,
    reason: 'вопрос / мелкая правка',
  },
  {
    words: /\b(fix|bug|add|change|update|write (a )?test|test|script|function|endpoint|style)\b|исправ|почини|баг|ошибк|добав|измени|поменяй|обнови|тест|скрипт|функци|стил/i,
    model: 'sonnet',
    effort: 'medium',
    mode: 'acceptEdits',
    weight: 2,
    reason: 'правка кода',
  },
  {
    words: /\b(refactor|migrat\w*|feature|implement|debug|investigate|integrat\w*|optimi[sz]e|performance)\b|рефактор|миграц|фич|реализуй|внедри|отлад|дебаг|разберись|интеграц|оптимиз|производительн|мод\b|плагин/i,
    model: 'sonnet',
    effort: 'medium',
    mode: 'plan',
    weight: 3,
    reason: 'многошаговая задача',
  },
  {
    words: /\b(architect\w*|design|system design|research|security|audit|from scratch|whole (repo|project|codebase))\b|архитектур|спроектируй|проектир|исследу|безопасност|аудит|с нуля|весь проект|всего проекта|всю кодовую/i,
    model: 'opus',
    effort: 'high',
    mode: 'plan',
    weight: 4,
    reason: 'архитектура / исследование',
  },
]

const FAST = /\b(quick(ly)?|asap|fast)\b|быстро|срочно|по-быстрому/i
const PATHS = /[\w./\\-]+\.(tsx?|jsx?|py|go|rs|java|cs|cpp|c|h|md|json|ya?ml|sql|html|css)\b/gi

export function classify(raw: string): Advice {
  const text = raw.trim()
  const hits = RULES.filter(rule => rule.words.test(text))
  const files = new Set(text.match(PATHS) ?? []).size
  const hasCode = text.includes('```')
  const best = hits.reduce<Rule | null>((top, rule) => (top === null || rule.weight > top.weight ? rule : top), null)

  const rule: Rule = best ?? RULES[text.length < 120 ? 0 : 1]!
  let effort = rule.effort
  let model = rule.model
  const notes = [best ? rule.reason : 'нет явных признаков']

  // Size and scope push a level up.
  if (text.length > 1500 || files >= 4) {
    if (model === 'haiku') model = 'sonnet'
    effort = bump(effort)
    notes.push(files >= 4 ? `${files} файлов` : 'длинный промпт')
  }
  if (hasCode && model === 'haiku') {
    model = 'sonnet'
    notes.push('есть код')
  }
  // Cheapest that copes: a small, clear edit in one place does not need Sonnet.
  if (rule.weight === 2 && files <= 1 && !hasCode && text.length < 160 && hits.length === 1 && !/bug|error|баг|ошибк|не работает|сломал/i.test(text)) {
    model = 'haiku'
    effort = 'medium'
    notes.push('маленькая правка')
  }

  // Confidence: one clear rule is confident; several conflicting or none is not.
  const distinct = new Set(hits.map(hit => hit.weight)).size
  let confidence = best === null ? 0.3 : distinct === 1 ? 0.85 : 0.55
  if (text.length < 15) confidence = Math.min(confidence, 0.4)

  return {
    model,
    effort,
    mode: rule.mode,
    fast: FAST.test(text) && model !== 'opus',
    confidence,
    reason: notes.join(', '),
    source: 'heuristic',
  }
}

function bump(effort: Effort): Effort {
  const order: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
  return order[Math.min(order.indexOf(effort) + 1, order.length - 1)] ?? effort
}

export const ADVISOR_PROMPT = `Classify the user's coding-assistant prompt. Goal: get the task done while spending as few tokens as possible.
Pick the CHEAPEST model and the LOWEST effort that will still do it correctly; only go up when a cheaper choice would likely fail.
haiku: questions, explanations, small clear edits in one place. sonnet: normal coding, bug fixes, features, multi-file changes. opus: only architecture, deep research, or hard debugging nobody could localize.
effort: low|medium|high|xhigh (prefer low/medium). mode: default (chat/questions), acceptEdits (clear small edits), plan (multi-step or risky changes), auto (long routine work).
fast: true only if the user wants speed.
Reply with JSON only: {"model":"...","effort":"...","mode":"...","fast":false,"reason":"<=6 words, in the prompt's language"}

Prompt:
`

export function parseAdvice(reply: string): Advice | null {
  const match = reply.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const v = JSON.parse(match[0])
    const models: ModelName[] = ['haiku', 'sonnet', 'opus']
    const efforts: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
    const modes: Mode[] = ['default', 'acceptEdits', 'plan', 'auto']
    if (!models.includes(v.model) || !efforts.includes(v.effort) || !modes.includes(v.mode)) return null
    return {
      model: v.model,
      effort: v.effort,
      mode: v.mode,
      fast: v.fast === true,
      confidence: 0.8,
      reason: String(v.reason ?? '').slice(0, 60),
      source: 'haiku',
    }
  } catch {
    return null
  }
}
