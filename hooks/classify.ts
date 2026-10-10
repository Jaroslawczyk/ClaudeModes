import type { Advice, Effort, Mode, ModelName } from '../types'

// Below this the heuristic is unsure and Haiku is asked (once, on demand).
export const ASK_HAIKU_BELOW = 0.6

// Task kinds, tested on the words of the whole prompt. Intent comes from verbs, never from nouns:
// «what does this function do» is a question even though it names a function.
const ARCH = /\b(architect\w*|system design|research|security|audit|from scratch|whole (repo|project|codebase))\b|архитектур|спроектируй|проектир|исследу|безопасност|аудит|с нуля|весь проект|всего проекта|всю кодовую/i
const MULTI = /\b(refactor|migrat\w*|feature|implement|integrat\w*|optimi[sz]e|performance)\b|рефактор|миграц|фич|реализуй|внедри|интеграц|оптимиз|производительн|\bмод\b|плагин/i
const EDIT = /\b(fix|add|change|update|make|write|create|remove|delete|move|replace|rename|set ?up|connect)\b|исправ|почини|добав|измени|поменяй|обнови|сделай|переделай|допиши|дополни|напиши|создай|удали|убери|перенеси|замени|подключи|настрой|переимен|перепиш|rewrite/i
const ANALYSIS = /\b(review|check|analy[sz]e|compare|investigate|debug)\b|провер|проанализ|найди|сравни|разберись|отлад/i
const ASK = /\?|\b(what|why|how|where|which|explain|translate|summari[sz]e)\b|что |как |почему|зачем|сколько|где |какой|какая|какие|объясни|расскажи|кратко|переведи/i
const BUG = /\b(bug|error|crash|fails?)\b|баг|ошибк|не работает|сломал|падает/i
// A previous attempt did not land: a cheap model that already missed is not retried cheap.
const LOOP = /не работает|опять|снова|всё ещё|все ещё|не помогло|та же ошибка|\b(still|again|same error)\b|doesn'?t work/i

const FAST = /\b(quick(ly)?|asap|fast)\b|быстро|срочно|по-быстрому/i
const PATHS = /[\w./\-]+\.(tsx?|jsx?|py|go|rs|java|cs|cpp|c|h|md|json|ya?ml|sql|html|css)\b/gi

export function classify(raw: string): Advice {
  const text = raw.trim()
  const files = new Set(text.match(PATHS) ?? []).size
  const hasCode = text.includes('```')
  const editVerbs = (text.match(new RegExp(EDIT.source, 'gi')) ?? []).length
  const listed = (text.match(/^\s*(?:\d+[.)]|[-*•])\s/gm) ?? []).length
  const steps = Math.max(editVerbs, listed)
  const edit = editVerbs > 0
  const bug = BUG.test(text)
  const loop = LOOP.test(text)
  const analysis = ANALYSIS.test(text)

  let model: ModelName
  let effort: Effort
  let mode: Mode
  let reason: string
  let confidence: number

  if (ARCH.test(text)) {
    ;[model, effort, mode, reason, confidence] = ['opus', 'high', 'plan', 'архитектура / исследование', 0.85]
  } else if (MULTI.test(text) || steps >= 3) {
    ;[model, effort, mode, reason, confidence] = ['sonnet', 'medium', 'plan', steps >= 3 ? `несколько шагов (${steps})` : 'многошаговая задача', 0.85]
  } else if (edit) {
    // Cheapest that copes: one small, clear edit that needs no reading of other code stays on Haiku.
    const small = files <= 1 && !hasCode && text.length < 200 && editVerbs <= 1 && !analysis && !bug && !loop
    if (small) {
      ;[model, effort, mode, reason] = ['haiku', 'medium', 'acceptEdits', 'маленькая правка']
    } else {
      ;[model, effort, mode, reason] = ['sonnet', 'medium', 'acceptEdits', bug ? 'исправление ошибки' : analysis ? 'разобраться и изменить' : 'правка кода']
    }
    confidence = text.length < 25 && files === 0 ? 0.5 : 0.85
  } else if (bug) {
    // Finding why something fails means reading code: not a job for the cheapest model.
    ;[model, effort, mode, reason, confidence] = ['sonnet', 'medium', 'default', 'разбор ошибки', 0.8]
  } else if (analysis) {
    ;[model, effort, mode] = files > 0 || hasCode ? (['sonnet', 'low', 'default'] as const) : (['haiku', 'medium', 'default'] as const)
    ;[reason, confidence] = [model === 'sonnet' ? 'анализ кода' : 'проверка / сравнение', 0.7]
  } else if (ASK.test(text) || text.length < 300) {
    ;[model, effort, mode, reason, confidence] = ['haiku', 'low', 'default', 'вопрос / обсуждение', ASK.test(text) ? 0.85 : 0.7]
  } else {
    ;[model, effort, mode, reason, confidence] = ['sonnet', 'low', 'default', 'длинный запрос без явной задачи', 0.45]
  }

  const notes = [reason]
  // Evidence of difficulty pushes up; nothing else does.
  if (loop) {
    if (model === 'haiku') model = 'sonnet'
    effort = bump(effort)
    notes.push('прошлая попытка не помогла')
  }
  if (text.length > 1500 || files >= 4) {
    if (model === 'haiku') model = 'sonnet'
    effort = bump(effort)
    notes.push(files >= 4 ? `${files} файлов` : 'длинный промпт')
  }
  if (hasCode && model === 'haiku') {
    model = 'sonnet'
    notes.push('есть код')
  }
  if (text.length < 15) confidence = Math.min(confidence, 0.4)

  return { model, effort, mode, fast: FAST.test(text) && model !== 'opus', confidence, reason: notes.join(', '), source: 'heuristic' }
}

function bump(effort: Effort): Effort {
  const order: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
  return order[Math.min(order.indexOf(effort) + 1, order.length - 1)] ?? effort
}

export const ADVISOR_PROMPT = `Classify the user's coding-assistant prompt. Goal: get the task done while spending as few tokens as possible.
When unsure between two models pick the cheaper one: a missed answer is cheap to retry on a stronger model, an overpowered one is never refunded.
Pick the CHEAPEST model and the LOWEST effort that will still do it correctly; only go up when a cheaper choice would likely fail.
haiku: questions, discussion, explanations, writing text, comparing options, small clear edits in one place. sonnet: normal coding, bug fixes, features, multi-file changes. opus: only architecture, deep research, or hard debugging nobody could localize.
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
