import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Advice, Choice, Effort, GraphState, Ledger, Limits, Mode, ModelName, Tokens } from '../types'
import { ADVISOR_PROMPT, classify, parseAdvice } from './classify'

const PANE = 'model-advisor-spend'

export const MODEL_IDS: Record<ModelName, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
}
const MODELS: ModelName[] = ['haiku', 'sonnet', 'opus']
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const MODES: Mode[] = ['default', 'acceptEdits', 'plan', 'auto']
const MODE_HINT: Record<Mode, string> = {
  default: 'обычный',
  acceptEdits: 'accept edits',
  plan: 'plan mode',
  auto: 'auto',
}

const EMPTY_LEDGER: Ledger = { byModel: {}, byTool: {}, advisor: zero(), turns: [] }

const adviceAtom = atom({ plugin: 'model-advisor', key: 'advice' } as const, null)
const choiceAtom = atom({ plugin: 'model-advisor', key: 'choice' } as const, null)
const editingAtom = atom({ plugin: 'model-advisor', key: 'isEditing' } as const, false)
const hiddenAtom = atom({ plugin: 'model-advisor', key: 'isHidden' } as const, false)
const ledgerAtom = atom({ plugin: 'model-advisor', key: 'ledger' } as const, EMPTY_LEDGER)
const limitsAtom = atom({ plugin: 'model-advisor', key: 'limits' } as const, { usd: null, context: null, windows: [] })
const graphAtom = atom({ plugin: 'model-advisor', key: 'graph' } as const, { status: 'idle', message: '' } as GraphState)

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// Auto-update only where a graph already exists: building a new one stays a deliberate click.
async function hasGraph($: EngineInterface): Promise<boolean> {
  try {
    return (await $.fs.stat(`${await $.session.cwd()}/graphify-out/graph.json`)).kind === 'file'
  } catch {
    return false
  }
}

const GRAPH_RU: Record<GraphState['status'], string> = { idle: '', running: 'строю граф', done: 'граф обновлён', failed: 'ошибка' }

// One click: AST-only graphify rebuild of the session's folder (no LLM, no token cost).
async function buildGraph($: EngineInterface, isAuto = false): Promise<void> {
  if ((await read($, graphAtom)).status === 'running') return
  await update($, graphAtom, () => ({ status: 'running', message: '' }))
  try {
    const r = await $.process.run(['graphify', 'update', '.'], { cwd: await $.session.cwd(), timeoutMs: 600_000 })
    const ok = r.exitCode === 0
    const tail = (ok ? r.stdout : r.stderr || r.stdout).trim().split('\n').slice(-1)[0] ?? ''
    await update($, graphAtom, () => ({ status: ok ? 'done' : 'failed', message: tail.slice(0, 120) }))
    if (!isAuto || !ok) $.ui.toast(ok ? 'graphify: граф обновлён' : 'graphify: ошибка сборки')
  } catch (err) {
    await update($, graphAtom, () => ({ status: 'failed', message: String(err).slice(0, 120) }))
    $.ui.toast('graphify: не запустился (есть ли graphify в PATH?)')
  }
}

function zero(): Tokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function add(a: Tokens, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }): Tokens {
  return {
    input: a.input + u.input_tokens,
    output: a.output + u.output_tokens,
    cacheRead: a.cacheRead + u.cache_read_input_tokens,
    cacheWrite: a.cacheWrite + u.cache_creation_input_tokens,
  }
}

export function total(t: Tokens): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite
}

export function short(model: string): string {
  const m = model.match(/(haiku|sonnet|opus|fable)/i)
  const name = m?.[1]?.toLowerCase()
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : model
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

const PINK = '#f06cb4'

// $ per 1M tokens (Anthropic API, cached 2026-10-06): input, output, cache read, cache write (1.25× input).
const PRICES: Record<ModelName, [number, number, number, number]> = {
  haiku: [0.1, 0.5, 0.01, 0.125],
  sonnet: [2, 10, 0.2, 2.5],
  opus: [4, 20, 0.2, 5],
}

function family(model: string): ModelName | null {
  const m = model.toLowerCase().match(/haiku|sonnet|opus/)
  return m ? (m[0] as ModelName) : null
}

function windowPct(windows: Limits['windows'], kind: string): number | null {
  return windows.find(w => w.kind === kind)?.percentUsed ?? null
}

// $ turned into limit % by what this chat measured; null until a turn has moved the limit.
export function asLimitPct(usd: number, ledger: Ledger, kind: '5h' | '7d'): number | null {
  const pct = kind === '5h' ? ledger.cal5h ?? 0 : ledger.cal7d ?? 0
  const spent = ledger.calUsd ?? 0
  return spent > 0 && pct > 0 ? (usd * pct) / spent : null
}

function pctText(p: number): string {
  return p < 0.1 ? '<0.1%' : `${p.toFixed(1)}%`
}

// What the same tokens cost on a model; null for one with no known price (e.g. Fable).
export function priceOf(model: string, t: Tokens): number | null {
  const f = family(model)
  if (f === null) return null
  const [i, o, cr, cw] = PRICES[f]
  return (t.input * i + t.output * o + t.cacheRead * cr + t.cacheWrite * cw) / 1_000_000
}
const MODEL_COLOR: Record<ModelName, string> = { haiku: '#5fb878', sonnet: '#6a9fe0', opus: '#c27ae0' }
const EFFORT_RU: Record<Effort, string> = { low: 'низкая', medium: 'средняя', high: 'высокая', xhigh: 'очень высокая', max: 'максимум' }

export function bar(percent: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function dots(effort: Effort): string {
  const n = EFFORTS.indexOf(effort) + 1
  return '●'.repeat(n) + '○'.repeat(EFFORTS.length - n)
}

function levelColor(percent: number): string {
  return percent >= 80 ? '#e06060' : percent >= 50 ? '#d0a050' : '#5fb878'
}

// Time left until a limit window resets, as «2ч 15м»; null when the engine gave no reset time.
function resetIn(iso: string | undefined): string | null {
  if (!iso) return null
  const ms = Date.parse(iso) - Date.now()
  if (Number.isNaN(ms)) return null
  if (ms <= 0) return 'сейчас'
  const mins = Math.ceil(ms / 60_000)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h >= 24) return `${Math.floor(h / 24)}д ${h % 24}ч`
  return h > 0 ? `${h}ч ${m}м` : `${m}м`
}

function windowLabel(kind: string): string {
  return kind === 'five_hour' ? '5ч' : kind === 'seven_day' ? '7д' : kind
}

function sameAdvice(a: Advice | null, b: Advice | null): boolean {
  return a?.model === b?.model && a?.effort === b?.effort && a?.mode === b?.mode && a?.fast === b?.fast && a?.reason === b?.reason
}

async function refreshLimits($: EngineInterface): Promise<void> {
  const usage = await $.session.usage()
  const limits: Limits = {
    usd: usage.cost?.usd ?? null,
    context: usage.context.percent ?? null,
    windows: usage.rateLimits.map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt })),
  }
  await update($, limitsAtom, () => limits)
}

type Lifetime = {
  cal: { calUsd: number; cal5h: number; cal7d: number }
  life: { saved: number; missed: number }
}

async function persist($: EngineInterface, l: Ledger): Promise<void> {
  const value: Lifetime = {
    cal: { calUsd: l.calUsd ?? 0, cal5h: l.cal5h ?? 0, cal7d: l.cal7d ?? 0 },
    life: { saved: l.life?.saved ?? 0, missed: l.life?.missed ?? 0 },
  }
  await $.store.set('lifetime', value)
}

const cache = new Map<string, Advice>()

async function askHaiku($: EngineInterface, text: string): Promise<void> {
  const r = await $.model.complete({
    model: 'haiku',
    effort: 'low',
    prompt: ADVISOR_PROMPT + text.slice(0, 4000),
    maxTokens: 120,
    timeoutMs: 8000,
  })
  await update($, ledgerAtom, l => ({ ...l, advisor: add(l.advisor, r.usage) }))
  const advice = r.isAnswered ? parseAdvice(r.text) : null
  if (advice === null) return
  cache.set(text, advice)
  await update($, adviceAtom, () => advice)
}

let judged = ''

// Drops the blocks the engine wraps around a prompt (<system-reminder>, <ide_…>, …).
export function userText(raw: string): string {
  return raw
    .replace(/<([a-z][\w-]*)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// The draft as last typed; read when the person presses «Проверить промпт».
let draft = ''

// On demand only: a free heuristic verdict at once, then Haiku's (a few hundred tokens) for longer prompts.
async function checkPrompt($: EngineInterface): Promise<void> {
  const text = draft.trim()
  if (text.length < 2 || text.startsWith('/')) {
    $.ui.toast('Сначала напишите промпт — потом нажмите «Проверить»')
    return
  }
  judged = text
  const cached = cache.get(text)
  await update($, adviceAtom, () => cached ?? classify(text))
  if (cached === undefined && text.length >= 15) {
    await askHaiku($, text)
  }
}

async function apply($: EngineInterface, choice: Choice): Promise<void> {
  await update($, choiceAtom, () => choice)
  const tips = [`Модель ${short(choice.model)} · ${choice.effort} применены к следующему ходу`]
  if (choice.mode !== 'default') tips.push(`режим ${MODE_HINT[choice.mode]}: Shift+Tab`)
  if (choice.fast) tips.push('быстрый режим: /fast')
  $.ui.toast(tips.join(' · '), { timeoutMs: 6000 })
}

export const register: Register = on => {
  let pending: { cancel: () => void } | null = null
  let warned = 0
  // Set when this turn changed files; the graph is refreshed once, at the turn's end.
  let edited = false
  let choiceUsed = false
  let adviceAtSubmit: Advice | null = null
  let turn: {
    prompt: string
    usdStart: number
    tokens: Tokens
    tools: Record<string, number>
    model: string
    priced: number
    w5: number | null
    w7: number | null
  } | null = null

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'spend', description: 'Где ушли токены и лимиты этой сессии' })
    await $.command.register({ name: 'advisor', description: 'Показать/скрыть подсказку модели над вводом' })
    await refreshLimits($)
    // A new chat starts from what earlier chats measured: calibration and lifetime savings.
    const kept = (await $.store.get('lifetime')) as Lifetime | null | undefined
    if (kept) await update($, ledgerAtom, l => ({ ...l, ...kept.cal, life: kept.life }))
    // Limits move with other chats and devices too: re-read them while idle, not only after a turn.
    $.clock.every(30_000, () => {
      void refreshLimits($)
    })

    return next(e)
  })

  on('command.run', { command: 'spend' }, async $ => {
    await refreshLimits($)
    await $.ui.open({ id: PANE, title: 'Расход сессии' })

    return { text: 'Панель расхода открыта.' }
  })

  on('command.run', { command: 'advisor' }, async $ => {
    const isHidden = await update($, hiddenAtom, v => !v)

    return { text: isHidden ? 'Подсказка скрыта.' : 'Подсказка включена.' }
  })

  // Advise while the person types: heuristic at once, Haiku after a pause when unsure.
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    draft = box.text
    // An old verdict no longer fits once the draft is cleared or rewritten.
    const current = await read($, adviceAtom)
    if (current !== null && !draft.trim().startsWith(judged.slice(0, Math.min(judged.length, 20)))) {
      await update($, adviceAtom, () => null)
    }

    return box
  })

  on('prompt.submit', async ($, e, next) => {
    pending?.cancel()
    pending = null
    // A one-turn choice that already served a turn is spent.
    if (choiceUsed) {
      choiceUsed = false
      const left = await read($, choiceAtom)
      if (left !== null && !left.isPersistent) await update($, choiceAtom, () => null)
    }
    if (e.turnId === undefined) {
      // e.text carries what the engine adds around the prompt; judge what the person typed.
      const typed = userText(e.text)
      const usd = (await $.session.usage()).cost?.usd ?? 0
      const before = (await read($, limitsAtom)).windows
      turn = {
        prompt: typed.slice(0, 120),
        usdStart: usd,
        tokens: zero(),
        tools: {},
        model: '',
        priced: 0,
        w5: windowPct(before, 'five_hour'),
        w7: windowPct(before, 'seven_day'),
      }
      // First message of the chat: nothing could be shown before it, so pick for it once.
      if ((await $.session.turns()) === 0 && (await read($, choiceAtom)) === null && !typed.startsWith('/')) {
        const a = classify(typed)
        await update($, choiceAtom, () => ({ model: a.model, effort: a.effort, mode: a.mode, fast: a.fast, isPersistent: false }))
        const tips = [`Автовыбор для 1-го сообщения: ${short(a.model)} · ${a.effort} — ${a.reason}`]
        if (a.mode !== 'default') tips.push(`советую режим ${MODE_HINT[a.mode]} (Shift+Tab)`)
        $.ui.toast(tips.join(' · '), { timeoutMs: 7000 })
      }
    }
    if (e.turnId === undefined) adviceAtSubmit = await read($, adviceAtom)
    await update($, adviceAtom, () => null)
    await update($, editingAtom, () => false)

    return next(e)
  })

  // Apply the chosen model/effort to main-thread requests and count every request's tokens.
  on('turn.step', async function* ($, e, next) {
    const choice = e.agentId === undefined ? await read($, choiceAtom) : null
    const event = choice
      ? { ...e, model: MODEL_IDS[choice.model], ...(choice.model === 'haiku' ? {} : { effort: choice.effort }) }
      : e
    if (choice !== null && !choice.isPersistent) choiceUsed = true
    const result = yield* next(event)
    const usage = result.usage
    if (usage === null) return result

    const stepTokens = add(zero(), usage)
    const spent = total(stepTokens)

    // Savings: this step against the chat's own model; missed: a cheaper shown advice left unapplied.
    if (e.agentId === undefined) {
      const actual = priceOf(usage.model, stepTokens)
      const base = priceOf(await $.session.model(), stepTokens)
      const advised = choice === null && adviceAtSubmit !== null ? priceOf(adviceAtSubmit.model, stepTokens) : null
      const saved = actual !== null && base !== null && base > actual ? base - actual : 0
      const missed = actual !== null && advised !== null && advised < actual ? actual - advised : 0
      if (saved > 0 || missed > 0) {
        await update($, ledgerAtom, l => ({
          ...l,
          saved: (l.saved ?? 0) + saved,
          missed: (l.missed ?? 0) + missed,
          life: { saved: (l.life?.saved ?? 0) + saved, missed: (l.life?.missed ?? 0) + missed },
        }))
        await persist($, await read($, ledgerAtom))
      }
    }
    if (e.agentId === undefined && result.toolUses.some(t => EDIT_TOOLS.has(t.name))) edited = true
    const names = e.agentId === undefined ? result.toolUses.map(t => t.name) : ['Agent (субагент)']
    await update($, ledgerAtom, l => {
      const byTool = { ...l.byTool }
      for (const name of names) {
        const row = byTool[name] ?? { calls: 0, tokens: 0 }
        byTool[name] = { calls: row.calls + (e.agentId === undefined ? 1 : 0), tokens: row.tokens + Math.round(spent / names.length) }
      }
      return { ...l, byTool, byModel: { ...l.byModel, [usage.model]: add(l.byModel[usage.model] ?? zero(), usage) } }
    })
    if (turn !== null) {
      turn.tokens = add(turn.tokens, usage)
      turn.priced += priceOf(usage.model, stepTokens) ?? 0
      if (e.agentId === undefined) turn.model = usage.model
      for (const name of names) turn.tools[name] = (turn.tools[name] ?? 0) + 1
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    await refreshLimits($)
    const limits = await read($, limitsAtom)
    if (turn !== null) {
      const done = turn
      // Learn how many limit % one API-priced dollar costs on this subscription.
      const d5 = done.w5 === null ? null : (windowPct(limits.windows, 'five_hour') ?? done.w5) - done.w5
      const d7 = done.w7 === null ? null : (windowPct(limits.windows, 'seven_day') ?? done.w7) - done.w7
      if (done.priced > 0 && d5 !== null && d5 >= 0) {
        await update($, ledgerAtom, l => ({
          ...l,
          calUsd: (l.calUsd ?? 0) + done.priced,
          cal5h: (l.cal5h ?? 0) + d5,
          cal7d: (l.cal7d ?? 0) + Math.max(0, d7 ?? 0),
        }))
        await persist($, await read($, ledgerAtom))
      }
      const usd = limits.usd === null ? 0 : Math.max(0, limits.usd - done.usdStart)
      await update($, ledgerAtom, l => ({
        ...l,
        turns: [...l.turns, { prompt: done.prompt, model: done.model, tokens: done.tokens, usd, tools: done.tools }].slice(-50),
      }))
      turn = null
    }
    const choice = await read($, choiceAtom)
    if (choice !== null && !choice.isPersistent) await update($, choiceAtom, () => null)
    if (edited) {
      edited = false
      if (await hasGraph($)) void buildGraph($, true)
    }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const five = e.rateLimits.find(w => w.kind === 'five_hour')
    await update($, limitsAtom, l => ({
      ...l,
      context: e.context.percent ?? l.context,
      windows: e.rateLimits.map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt })),
    }))
    const level = five === undefined ? 0 : five.percentUsed >= 90 ? 90 : five.percentUsed >= 80 ? 80 : 0
    if (level > warned) {
      warned = level
      $.ui.toast(`Лимит 5ч использован на ${five?.percentUsed}% — переходите на Haiku/Sonnet и low effort`)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, hiddenAtom))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const advice = await read($, adviceAtom)
    const choice = await read($, choiceAtom)
    const isEditing = await read($, editingAtom)
    const limits = await read($, limitsAtom)
    const ledger = await read($, ledgerAtom)
    // On a subscription the saving reads as limit %, with $ beside it; elsewhere as $.
    const amount = (usd: number) => {
      const p = limits.windows.length > 0 ? asLimitPct(usd, ledger, '5h') : null
      return p === null ? `$${usd.toFixed(2)}` : `${pctText(p)} лимита 5ч`
    }
    const chatTokens =Object.values(ledger.byModel).reduce((s, t) => s + total(t), 0) + total(ledger.advisor)
    const base: Choice = choice ?? {
      model: advice?.model ?? 'sonnet',
      effort: advice?.effort ?? 'medium',
      mode: advice?.mode ?? 'default',
      fast: advice?.fast ?? false,
      isPersistent: false,
    }
    const setPick = (patch: Partial<Choice>) => update($, choiceAtom, () => ({ ...base, ...patch }))

    const life = ledger.life ?? { saved: 0, missed: 0 }
    const graph = await read($, graphAtom)
    const label = (text: string) => (
      <Box width={11}>
        <Text bold color={PINK}>{text}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {advice === null && !e.props.isWorking && (
          <Box gap={2}>
            <Button key="check" label="🔍 Проверить промпт" onPress={() => checkPrompt($)} />
            <Text dimColor>подберу самую дешёвую модель, которая справится</Text>
          </Box>
        )}
        {advice !== null && !e.props.isWorking && (
          <Box flexDirection="column" borderStyle="round" borderColor="#d0a050" paddingX={1}>
            <Box gap={2}>
              <Text bold>💡 Совет</Text>
              <Text>
                <Text dimColor>модель </Text>
                <Text bold color={MODEL_COLOR[advice.model]}>{short(advice.model)}</Text>
              </Text>
              <Text>
                <Text dimColor>сила </Text>
                <Text color="#d0a050">{dots(advice.effort)}</Text>
                <Text> {EFFORT_RU[advice.effort]}</Text>
              </Text>
              <Text>
                <Text dimColor>режим </Text>
                <Text bold>{MODE_HINT[advice.mode]}</Text>
                {advice.fast ? <Text color="#d0a050"> ⚡fast</Text> : null}
              </Text>
            </Box>
            <Text dimColor>
              ↳ {advice.reason} · {advice.source === 'haiku' ? 'оценил Haiku' : 'по ключевым словам'}
            </Text>
            <Box gap={2}>
              <Button
                key="apply"
                label="Применить"
                onPress={() => apply($, { model: advice.model, effort: advice.effort, mode: advice.mode, fast: advice.fast, isPersistent: false })}
              />
              <Button key="recheck" label="↻ Перепроверить" plain onPress={() => checkPrompt($)} />
              <Button key="own" label={isEditing ? 'Готово' : 'Своё…'} plain onPress={() => update($, editingAtom, v => !v)} />
            </Box>
          </Box>
        )}
        {isEditing && !e.props.isWorking && (
          <Box flexDirection="column" paddingX={1}>
            <Box gap={1}>
              <Box width={8}><Text dimColor>модель</Text></Box>
              {MODELS.map(m => (
                <Button key={`m-${m}`} label={m === base.model ? `[${short(m)}]` : short(m)} plain onPress={() => setPick({ model: m })} />
              ))}
            </Box>
            <Box gap={1}>
              <Box width={8}><Text dimColor>сила</Text></Box>
              {EFFORTS.map(f => (
                <Button key={`f-${f}`} label={f === base.effort ? `[${f}]` : f} plain onPress={() => setPick({ effort: f })} />
              ))}
            </Box>
            <Box gap={1}>
              <Box width={8}><Text dimColor>режим</Text></Box>
              {MODES.map(m => (
                <Button key={`r-${m}`} label={m === base.mode ? `[${MODE_HINT[m]}]` : MODE_HINT[m]} plain onPress={() => setPick({ mode: m })} />
              ))}
            </Box>
          </Box>
        )}
        {choice !== null && (
          <Box gap={2} paddingX={1}>
            <Text color="success">
              ✔ Выбрано: {short(choice.model)} · {choice.effort} {choice.isPersistent ? '(закреплено)' : '(на 1 ход)'}
            </Text>
            <Button key="pin" label={choice.isPersistent ? 'Открепить' : 'Закрепить'} plain onPress={() => setPick({ isPersistent: !choice.isPersistent })} />
            <Button key="reset" label="Сбросить" plain onPress={() => update($, choiceAtom, () => null)} />
          </Box>
        )}
        {(limits.windows.length > 0 || limits.context !== null || limits.usd !== null) && (
          <Box flexDirection="column" borderStyle="round" borderColor="#555555" paddingX={1}>
            <Box gap={3}>
              {label('Этот чат')}
              {limits.context !== null && (
                <Text>
                  <Text dimColor>контекст </Text>
                  <Text color={levelColor(limits.context)}>{bar(limits.context)}</Text>
                  <Text bold> {Math.round(limits.context)}%</Text>
                </Text>
              )}
              <Text>
                <Text dimColor>токены </Text>
                <Text bold>{fmt(chatTokens)}</Text>
              </Text>
              {limits.usd !== null && (
                <Text>
                  <Text dimColor>стоимость </Text>
                  <Text bold>${limits.usd.toFixed(2)}</Text>
                </Text>
              )}
              <Text dimColor>/spend — подробности</Text>
            </Box>
            <Box gap={3}>
              {label('Экономия')}
              <Text>
                <Text color="#5fb878">💰 сэкономлено </Text>
                <Text bold color="#5fb878">{amount(ledger.saved ?? 0)}</Text>
              </Text>
              <Text>
                <Text color="#e06060">упущено </Text>
                <Text bold color="#e06060">{amount(ledger.missed ?? 0)}</Text>
              </Text>
              <Text dimColor>
                за всё время: +{amount(life.saved)} / −{amount(life.missed)}
              </Text>
            </Box>
            {limits.windows.length > 0 && (
              <Box gap={3}>
                {label('Лимиты')}
                {limits.windows.map(w => (
                  <Text>
                    <Text dimColor>{w.kind === 'five_hour' ? '5 часов ' : w.kind === 'seven_day' ? 'неделя ' : `${w.kind} `}</Text>
                    <Text color={levelColor(w.percentUsed)}>{bar(w.percentUsed)}</Text>
                    <Text bold> {Math.round(w.percentUsed)}%</Text>
                    {resetIn(w.resetsAt) !== null && <Text dimColor> · сброс через {resetIn(w.resetsAt)}</Text>}
                  </Text>
                ))}
              </Box>
            )}
            <Box gap={3}>
              {label('Граф')}
              <Button
                key="graphify-build"
                label={graph.status === 'running' ? 'Строю граф…' : 'Построить / обновить граф'}
                onPress={() => {
                  void buildGraph($)
                }}
              />
              <Text dimColor>
                {graph.status === 'idle'
                  ? 'graphify update . — только разбор кода, без LLM и токенов'
                  : `${GRAPH_RU[graph.status]}${graph.message ? ` — ${graph.message}` : ''}`}
              </Text>
            </Box>
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const ledger = await read($, ledgerAtom)
    const limits = await read($, limitsAtom)

    const models = Object.entries(ledger.byModel).sort((a, b) => total(b[1]) - total(a[1]))
    const allTokens = models.reduce((s, [, t]) => s + total(t), 0) || 1
    const tools = Object.entries(ledger.byTool).sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 10)
    const turns = [...ledger.turns].sort((a, b) => b.usd - a.usd || total(b.tokens) - total(a.tokens)).slice(0, 8)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>Итого</Text>
          <Text>
            Стоимость: {limits.usd === null ? '—' : `$${limits.usd.toFixed(3)}`} · контекст:{' '}
            {limits.context === null ? '—' : `${Math.round(limits.context)}%`}
          </Text>
          {limits.windows.map(w => (
            <Text>
              Лимит {windowLabel(w.kind)}: {w.percentUsed}%{w.resetsAt ? ` (сброс ${w.resetsAt.slice(0, 16).replace('T', ' ')})` : ''}
            </Text>
          ))}
          {total(ledger.advisor) > 0 && <Text dimColor>Сам советчик (Haiku): {fmt(total(ledger.advisor))} ток.</Text>}
        </Box>
        <Box flexDirection="column">
          <Text bold>Экономия</Text>
          <Text color="#5fb878">
            💰 Сэкономлено: ${(ledger.saved ?? 0).toFixed(3)} — ходы шли на модели дешевле той, что выбрана в чате
          </Text>
          <Text color="#e06060">
            ✗ Упущено: ${(ledger.missed ?? 0).toFixed(3)} — совет был дешевле, но его не применили
          </Text>
          {(ledger.saved ?? 0) + (ledger.missed ?? 0) > 0 && (
            <Text>
              <Text color="#5fb878">{bar(((ledger.saved ?? 0) / ((ledger.saved ?? 0) + (ledger.missed ?? 0))) * 100, 20)}</Text>
              <Text dimColor> использовано {Math.round(((ledger.saved ?? 0) / ((ledger.saved ?? 0) + (ledger.missed ?? 0))) * 100)}% возможной экономии</Text>
            </Text>
          )}
          {limits.windows.length > 0 && (
            <Box flexDirection="column">
              {(() => {
                const s5 = asLimitPct(ledger.saved ?? 0, ledger, '5h')
                const m5 = asLimitPct(ledger.missed ?? 0, ledger, '5h')
                const s7 = asLimitPct(ledger.saved ?? 0, ledger, '7d')
                const m7 = asLimitPct(ledger.missed ?? 0, ledger, '7d')
                if (s5 === null) {
                  return <Text dimColor>Подписка: % лимитов появятся после ходов, которые сдвинут лимит 5ч (мод замеряет, сколько % стоит $1)</Text>
                }
                return (
                  <Box flexDirection="column">
                    <Text>
                      <Text dimColor>Подписка, лимит 5ч: </Text>
                      <Text bold color="#5fb878">сэкономлено {pctText(s5)}</Text>
                      <Text dimColor> · </Text>
                      <Text bold color="#e06060">упущено {pctText(m5 ?? 0)}</Text>
                    </Text>
                    {s7 !== null && (
                      <Text>
                        <Text dimColor>Подписка, неделя: </Text>
                        <Text bold color="#5fb878">сэкономлено {pctText(s7)}</Text>
                        <Text dimColor> · </Text>
                        <Text bold color="#e06060">упущено {pctText(m7 ?? 0)}</Text>
                      </Text>
                    )}
                    <Text dimColor>
                      Замер: ${(ledger.calUsd ?? 0).toFixed(2)} по ценам API сдвинули лимит 5ч на {(ledger.cal5h ?? 0).toFixed(1)}%
                    </Text>
                  </Box>
                )
              })()}
            </Box>
          )}
          <Text dimColor>Цены API за 1M токенов: Haiku $0.10/$0.50 · Sonnet $2/$10 · Opus $4/$20 (вход/выход)</Text>
        </Box>
        <Box flexDirection="column">
          <Text bold>По моделям</Text>
          {models.length === 0 && <Text dimColor>Пока нет запросов.</Text>}
          {models.map(([model, t]) => (
            <Text>
              {short(model).padEnd(8)} {fmt(total(t)).padStart(7)} ({Math.round((total(t) / allTokens) * 100)}%) · вход {fmt(t.input)} · выход {fmt(t.output)} · кэш {fmt(t.cacheRead)}/{fmt(t.cacheWrite)}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text bold>На что ушло (инструменты)</Text>
          {tools.length === 0 && <Text dimColor>Инструменты не вызывались.</Text>}
          {tools.map(([name, s]) => (
            <Text>
              {name.padEnd(20)} {String(s.calls).padStart(3)} выз. · {fmt(s.tokens)} ток.
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text bold>Самые дорогие ходы</Text>
          {turns.length === 0 && <Text dimColor>Ходов ещё не было.</Text>}
          {turns.map(t => (
            <Text wrap="truncate-end">
              ${t.usd.toFixed(3)} · {fmt(total(t.tokens))} · {short(t.model)} · «{t.prompt}»
            </Text>
          ))}
        </Box>
      </Box>
    )
  })
}
