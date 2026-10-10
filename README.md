# model-advisor

**English** · [Русский](README.ru.md)

A Claude Code mod that suggests the cheapest model, effort and mode that can handle a task, and shows where your tokens and limits go.

## Install

```
/plugin marketplace add Jaroslawczyk/ClaudeModes
/plugin install model-advisor@claude-modes
```

Changes to the mod take effect in a new session (a new chat).

## What you see

Two blocks sit above the prompt box. The interface is in Russian.

**Advice.** The «🔍 Проверить промпт» (Check prompt) button rates what you typed and shows the model, effort (●○○○○), mode and the reason.
- «Применить» (Apply): the choice applies to the next turn.
- «Своё…» (Custom): pick model, effort and mode by hand.
- «Закрепить» (Pin): the choice applies until the session ends. «Сбросить» (Reset) clears it.
- The first message of a chat gets a model picked automatically.

**Stats.** Four rows:

| Row | What it shows |
| --- | --- |
| Этот чат (This chat) | context fill, tokens, cost |
| Экономия (Savings) | saved and missed, for this chat and all time |
| Лимиты (Limits) | 5-hour and weekly limits, time until reset (`2ч 15м`, `3д 4ч`); refreshes itself every 30 seconds |
| Граф (Graph) | a button that runs `graphify update .` for the session folder |

**`/spend` pane.** Spending by model, by tool, the most expensive turns, and what the advisor itself used.

Commands: `/spend` opens the pane, `/advisor` hides or shows the advice.

## How the model is chosen

The rule: **start with the cheapest model and move up only on signs of difficulty.**

The kind of task is read from verbs, not nouns: "what does this function do" stays a question even though it mentions a function. The rules live in `hooks/classify.ts` and are checked top to bottom:

| Signal in the prompt | Choice |
| --- | --- |
| architecture, audit, security, "from scratch", "whole project" | Opus, high, plan |
| refactor, migration, feature, "implement", integration, mod or plugin; 3 or more steps | Sonnet, medium, plan |
| one small edit: under 200 characters, at most 1 file, no code, no words about errors | Haiku, medium, accept edits |
| an edit that needs understanding first, involves a bug, or touches several files | Sonnet, medium, accept edits |
| a bug without a request to change code ("why does it fail") | Sonnet, medium |
| code analysis ("check", "compare", "find") with a file or code | Sonnet, low |
| a question, discussion, writing, comparison without code | Haiku, low or medium |
| a long prompt (300+ characters) with no clear task | Sonnet, low; Haiku is asked to refine |

Keywords are matched in both Russian and English.

The choice moves up only in these cases:
- **A previous attempt failed** ("again", "still", "same error", `опять`, `не помогло`): Haiku becomes Sonnet and effort goes up one step.
- **4 or more files, or a prompt over 1,500 characters:** effort goes up one step and Haiku becomes Sonnet.
- **A code block in the prompt:** Haiku becomes Sonnet.

Words like "quick", "asap", `быстро`, `срочно` turn on fast mode (`/fast`), except for Opus.

**When Haiku is asked.** Only when the keywords give no confident answer (confidence below 0.6): a very short or vague edit, or a long text with no task. A confident heuristic answer is never overridden and costs no tokens, so the same prompt always gets the same advice.

**Model switch warning.** The context cache belongs to a model. Switching models in a long chat (30k+ tokens of context) writes the whole context to the cache again, and the first turn can cost more than the switch saves. The advice then carries a note such as «смена модели пересчитает кэш 120k ток. (+$0.28 на 1-м ходе)» ("switching re-writes 120k tokens of cache, +$0.28 on the first turn"). In a long chat, starting a new chat is cheaper.

## Graph (graphify)

- The button in the «Граф» row runs `graphify update .` in the session folder. It only parses code: no LLM, no tokens. Requires graphify (the `graphify` command on PATH).
- If the folder already has a graph (`graphify-out/graph.json`), it updates itself at the end of any turn in which Claude edited files with Edit or Write.
- Turns without edits leave the graph alone. A new graph is never built automatically, only with the button.
- Edits made through Bash (scripts, `sed`) are not noticed.

## What costs model calls

| What | Cost |
| --- | --- |
| Keyword advice | free, computed locally |
| Haiku advice | only on the button and only when the heuristic is unsure; low effort, at most 120 output tokens, prompt cut to 4,000 characters; re-checking the same text comes from a cache |
| Savings, tokens, limits | free: arithmetic on data the engine reports after each step |
| Graph | free: code parsing without an LLM |

Nothing is sent while you type. Haiku calls show up as a separate line in `/spend`.

## How savings are counted

- **Saved:** what the same tokens would have cost on the chat's model, minus what they cost on the model you chose. Uses API prices.
- **Missed:** the advice offered a cheaper model, but it was not applied.
- **Limit percentages:** on a subscription, dollars are not charged. The mod measures how many percent of the 5-hour limit one API-priced dollar moves, and converts savings into percent. Measurements carry over between chats.

Prices are hard-coded in `hooks/register.tsx` (`PRICES`), per 1M tokens, input and output: Haiku $0.10 / $0.50, Sonnet $2 / $10, Opus $4 / $20. Update them by hand if prices change.

## How useful is it

- **Savings appear only when you switch to a cheaper model.** If the chat is already on Haiku, there is nothing to save and "saved" stays at zero.
- **"Saved" is hypothetical.** It is a difference in API prices, not money returned. It shows which choice is cheaper.
- **The advice can be wrong.** The mod sees only the prompt text, not the real difficulty. "Add the time until the limit resets" looks like a small edit but may need reading unfamiliar code. Erring low is usually cheap (retry on Sonnet), but not free.
- **Limit percentages are approximate** until enough turns are measured.
- **Average savings are not measured.** To find out, compare `/spend` by model over a few weeks with and without the mod.

In short: the mod shows where tokens and limits go and nudges you toward a cheaper model when the task is simple. It does not guarantee savings; those depend on whether you apply the advice.

## Files

| File | Contents |
| --- | --- |
| `hooks/register.tsx` | logic, blocks above the prompt, the `/spend` pane |
| `hooks/classify.ts` | model selection rules and Haiku reply parsing |
| `hooks/advisor.test.ts` | tests |
| `types/index.d.ts` | state types |
| `.claude-plugin/` | manifest and marketplace |
