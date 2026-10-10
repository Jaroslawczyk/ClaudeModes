import { describe, expect, test } from 'claude-code/testing'

import { classify, parseAdvice } from './classify'
import { priceOf, short, total, userText } from './register'

describe('classify', () => {
  test('simple question goes to Haiku, low effort', async () => {
    const a = classify('что такое замыкание в JavaScript?')
    expect(a.model).toBe('haiku')
    expect(a.effort).toBe('low')
    expect(a.mode).toBe('default')
  })

  test('bug fix goes to Sonnet with accept edits', async () => {
    const a = classify('fix the bug in src/api/user.ts where the token is null')
    expect(a.model).toBe('sonnet')
    expect(a.mode).toBe('acceptEdits')
  })

  test('refactor across many files goes to plan mode, high effort', async () => {
    const a = classify('рефактор модуля авторизации: auth.ts, session.ts, user.ts, token.ts — вынести общую логику')
    expect(a.mode).toBe('plan')
    expect(a.effort === 'high' || a.effort === 'xhigh').toBe(true)
  })

  test('architecture goes to Opus', async () => {
    const a = classify('спроектируй архитектуру сервиса уведомлений с очередями')
    expect(a.model).toBe('opus')
    expect(a.mode).toBe('plan')
  })

  test('vague prompt has low confidence (Haiku is asked)', async () => {
    expect(classify('сделай как раньше').confidence < 0.6).toBe(true)
  })

  test('speed words ask for fast mode', async () => {
    expect(classify('быстро исправь опечатку в README.md').fast).toBe(true)
  })
})

describe('first message', () => {
  test('a greeting wrapped in engine context goes to Haiku', async () => {
    const raw = 'привет\n<system-reminder>\n' + 'add fix test refactor '.repeat(200) + '\n</system-reminder>'
    const a = classify(userText(raw))
    expect(userText(raw)).toBe('привет')
    expect(a.model).toBe('haiku')
    expect(a.effort).toBe('low')
  })
})

describe('cheapest that copes', () => {
  test('a small clear edit goes to Haiku', async () => {
    expect(classify('добавь кнопку выхода в header.tsx').model).toBe('haiku')
  })

  test('a multi-step task stays on Sonnet, not Opus', async () => {
    expect(classify('реализуй экспорт отчётов в CSV для admin.ts, report.ts, api.ts').model).toBe('sonnet')
  })
})

describe('savings', () => {
  test('Haiku is far cheaper than Sonnet on the same tokens', async () => {
    const t = { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 }
    expect(priceOf('claude-sonnet-5-5', t)).toBe(3)
    expect(priceOf('claude-haiku-5-5', t)).toBe(0.15)
    expect(priceOf('claude-fable-5-1', t)).toBe(null)
  })
})

describe('parseAdvice', () => {
  test('reads a JSON reply', async () => {
    const a = parseAdvice('```json\n{"model":"sonnet","effort":"medium","mode":"plan","fast":false,"reason":"фича"}\n```')
    expect(a?.model).toBe('sonnet')
    expect(a?.source).toBe('haiku')
  })

  test('refuses unknown values', async () => {
    expect(parseAdvice('{"model":"gpt","effort":"low","mode":"plan"}')).toBe(null)
  })
})

describe('helpers', () => {
  test('short names a model id', async () => {
    expect(short('claude-sonnet-5-5')).toBe('Sonnet')
    expect(total({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })).toBe(10)
  })
})
