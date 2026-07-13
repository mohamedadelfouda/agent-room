# Agent Room — Design System

## Theme decision (scene sentence)
A developer at his desk in the evening, reading a live, dense debate between two AI agents on a
27" screen over a long session, wanting calm focus and zero glare while scanning who-said-what and
deciding. → **Dark, but warm and low-glare**, not the blue-black "gamer/AI" dark. Refined charcoal
tinted slightly warm so long reading is comfortable.

## Color strategy: Restrained
Warm-tinted neutral surfaces + agents carry the color. The UI chrome is neutral; **identity color
comes from the agents themselves** (Claude warm, Codex cool), not from a generic brand purple. One
quiet accent for primary user actions. This dodges the "AI tool = neon purple on black" reflex.

All colors OKLCH. Neutrals tinted warm (hue ~60), low chroma.

```
--bg:        oklch(0.165 0.008 60)   /* warm near-black */
--surface:   oklch(0.205 0.008 60)
--surface-2: oklch(0.245 0.009 60)
--line:      oklch(0.315 0.008 60)
--text:      oklch(0.955 0.006 75)
--muted:     oklch(0.70 0.012 68)
--accent:    oklch(0.68 0.12 248)    /* calm blue — primary actions (NOT purple) */
--accent-ink:oklch(0.20 0.03 248)
--claude:    oklch(0.74 0.10 52)     /* warm terracotta/amber — Claude identity */
--codex:     oklch(0.82 0.028 235)   /* cool light slate — Codex identity */
--ok:        oklch(0.72 0.13 155)
--warn:      oklch(0.78 0.12 78)
--danger:    oklch(0.66 0.17 25)
```

Never `#000`/`#fff`. No gradient text. No side-stripe accent borders. No glass.

## Typography
- System UI stack for chrome; the agent text is body prose.
- Body reading measure capped ~72ch inside the conversation column.
- Hierarchy by scale + weight (ratio ≥1.25): session title (h1) > agent name > badges/meta.
- Numerals for metadata are `font-variant-numeric: tabular-nums`.

## Layout
- Two zones: **sessions rail** (narrow) + **main** (header, conversation, composer).
- Direction-aware via `dir` on `<html>`: RTL → rail on the right; LTR → rail on the left. Use CSS
  logical properties (`inline-start/end`, `margin-inline`, `border-inline`) so it flips for free.
- **Focused session view:** when a session is open the conversation dominates. Agent/mode **setup lives
  in a collapsible drawer** opened from the header, not permanently pinned above the chat. The header
  shows a compact live summary (mode · participants · rounds) so setup stays glanceable while hidden.
- Vary spacing for rhythm; the conversation column is generous, the rail is tight.
- Cards only where they earn it: agent messages are cards (distinct authored blocks); everything else
  is not boxed.

## Components
- **Agent message:** avatar (colored initial: Claude warm, Codex cool) + name + role/phase badges +
  prose + a quiet metadata footer (model · effort · duration · context). Partial → warm outline +
  "رد جزئي" tag. Error → danger-tinted, clean message, technical behind a `<details>`.
- **Header config summary + drawer toggle:** "تعاون · Claude + Codex · جولة" with a chevron toggle.
- **Composer:** full-width textarea + primary "ابدأ الجولة", Ctrl/Cmd+Enter to send.
- **Sessions rail item:** title + status dot + mode · message count.
- **Modal (new session):** used sparingly (creation only); in-page, inline errors, never native `prompt()`.
- **Connection status** at the rail foot: dot + متصل/غير متصل + click to retry.

## Motion
- Only opacity/transform. Drawer + modal ease-out (cubic-bezier(0.16,1,0.3,1)), ~180ms. No bounce.

## i18n
- `lang`/`dir` toggle (AR/EN) flips direction and translates chrome strings via a small strings map.
  Agent output stays in whatever language the user wrote.
