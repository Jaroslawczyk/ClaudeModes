export type Lang = 'ru' | 'en'

// The interface language is one module-wide value: render hooks and toasts all read it through tr().
let current: Lang = 'ru'

export function getLang(): Lang {
  return current
}

export function setLang(lang: Lang): void {
  current = lang
}

// Picks the Russian or the English text of a string.
export function tr(ru: string, en: string): string {
  return current === 'ru' ? ru : en
}
