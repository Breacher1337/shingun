# shingun (進軍) — design language

The written specification for how shingun looks and feels. The living
artifacts are two files, both served by the local console:

| Artifact | Route | Role |
| --- | --- | --- |
| `web/tokens.css` | `/tokens.css` | the token layer — single source of truth for every value |
| `web/theme-preview.html` | `/theme-preview.html` | the live gallery — every token and component, switchable in place |

One CSS file, zero dependencies, no build step. If a value matters to the
product, it lives in `tokens.css`; if a screen uses it, the screen consumes
the semantic token — never a raw hex.

---

## 1. Brand in one line

shingun (進軍) — "to march, to advance" — is a mission console: dark,
terminal-literate, calm under swarm. The interface holds formation while
the workers run: quiet surfaces, precise hairlines, and signal color used
only where meaning lives. Decoration is not a goal; legibility at 2 a.m. is.

## 2. Themes

Three uniforms, one language. Switching is instant and survives restarts.

| Theme | Identity | Wear it when |
| --- | --- | --- |
| `cocytus` *(flagship, default)* | the frozen river — glacier teal over dark water, signal hues tuned for long log-reading | daytime missions, screen shares, anything public-facing |
| `albedo` | volcanic glass — pure neutral blacks, chiseled whites, contrast-first | low-light operator pits, projector walls, maximum-contrast needs |
| `demiurge` | night-ops charcoal — warm hearth tones, amber signal fires | long overnight sessions, tired eyes |

Rules:

1. **Switching contract.** The active theme is the `data-theme` attribute on
   `<html>`. No attribute means `cocytus`. The console persists the operator's
   choice under `shingun.theme` in browser storage and re-applies it at boot.
2. **Status hues are constant across themes.** Reasoning reads blue, tools
   amber, stalls orange, solved green, terminal slates, dead reds — in every
   uniform. An operator's reflexes must survive a theme switch.
3. **A theme ships complete.** Any color token exists in all three themes.
   There are no per-theme shims, no `!important` overrides, no half-dressed
   screens.
4. **Contrast floors.** `--text-hi` on `--surface-0` clears 12:1;
   `--text-low` clears 4.5:1. Status color paired with its `*-soft` surface
   tint keeps text readable inside pills. A theme that fails the floor is
   not a theme.

## 3. Token taxonomy

### Color — semantic only

| Group | Tokens | Meaning |
| --- | --- | --- |
| Surfaces | `--surface-0` … `--surface-3`, `--surface-veil` | app background → panels → raised panels → code wells; `veil` dims the page behind modals |
| Lines | `--line-1`, `--line-2` | resting and emphasized hairlines |
| Text | `--text-hi`, `--text-mid`, `--text-low`, `--text-faint` | primary, secondary, labels/meta, disclaimers/ids |
| Brand | `--accent`, `--accent-strong`, `--accent-soft` | primary actions, lit accent (focus, highlights), tint background |
| Status | `--status-spawn/reasoning/tool/stall/solved/finish/dead`, each with `-soft` | worker and swarm states |
| Feedback | `--danger`, `--warn`, `--ok` and their `-soft` | indirect aliases onto the status hues — for copy that is not a swarm state |

Two hard rules:

- **Components consume semantics.** Buttons, chips, meters, and tiles read
  `--surface-2` and `--status-stall`; they never read `#3a2f26`.
- **Primitives never leak.** Raw hex values appear only inside
  `tokens.css`. A hex literal in a component stylesheet is a bug.

### Shared scales — theme-independent

| Group | Tokens | Values |
| --- | --- | --- |
| Type | `--font-mono`, `--font-display` | the terminal stack; display inherits mono — this is a console, not a brochure |
| | `--fs-xs` … `--fs-display` | 10 · 11 · 12 · 13 · 15 · 18 · 26 px |
| | `--fw-regular/semibold/bold` | 400 · 600 · 700 |
| Space | `--sp-1` … `--sp-8` | 2 · 4 · 6 · 8 · 12 · 16 · 20 · 24 px — no odd numbers, no exceptions outside the ladder |
| Radius | `--radius-sm/md/lg/xl`, `--radius-pill` | 5 · 7 · 10 · 14 · 999 px |
| Elevation | `--elev-1/2/3` | panel / dock / modal shadows; flat by default |
| Motion | `--motion-fast/slow/meter` | 120 ms (hover, focus) · 240 ms (drawers, modals) · 400 ms (meter fills) |
| Focus | `--focus-color`, `--focus-offset` | lit accent ring, 2 px outside the box |
| Stacking | `--z-sticky/drawer/dock/toast/modal` | 20 · 25 · 30 · 60 · 70 — top bar, inspector, deck, toasts, overlays |

## 4. Component recipes

The preview gallery renders each of these live against all three themes.

**Buttons** — `--surface-2` fill, `--line-2` border, `--radius-sm`.
Primary inverts to `--accent` with white ink. Danger is outlined in
`--status-dead` with `--warn` ink (an outline threatens; a fill executes).
Disabled drops to 45% opacity and refuses the pointer. Focus ring:
`--focus-color`, offset `--focus-offset`.

**Status pills** — `--radius-pill`, the status hue as ink, its `-soft` as
fill and border, a 6–8 px dot of the pure hue leading the label. Never ship
a color without its word: dot + label + context is the minimum viable state.

**Meters** — 8 px track on `--surface-2` with `--line-2` hairline; fill is
`--accent` until 70%, `--warn` past 70%, `--danger` at 100%. Fill animates
at `--motion-meter` — width only.

**Chips** — informational, `--radius-pill`, `--surface-2`, `--fs-sm`.
Chips are nouns; pills are states.

**Inputs** — `--surface-0` well inside the `--surface-1` panel (sinks, not
floats), `--line-2` border, `--radius-sm`, mono ink.

**Worker tiles** — `--surface-1` card, `--radius-lg`, `--elev-1`. Status
pill top-right; meter row mid; last tool-line single-ellipsis at
`--text-low`; findings on the solving color's `-soft`.

**Toasts** — `--surface-2`, `--radius-md`, a 3 px left rail in the acting
hue (brand for info, `--ok` for flags, `--warn` for caps), 45 ch max line.

**Modals** — `--surface-2` on the `--surface-veil` backdrop, `--line-2`
border, `--radius-lg`, `--elev-3`. One modal per concern; dismiss is always
reachable.

**Tables** — hairline `--line-1` rows, no zebra striping, uppercase
`--fs-xs` heads at `--text-low`. Density is a feature.

## 5. Accessibility floors

1. **Contrast:** 4.5:1 minimum for body text on any surface pair actually
   used; 3:1 for large type and state indicators.
2. **Never color alone:** every status carries a label (and usually a dot
   and a shape). The `stalled` pill reads in `albedo` at a glance without
   knowing which theme you are wearing.
3. **Focus is visible:** interactive elements own a `--focus-color` ring on
   `:focus-visible`. Keyboard operation is a first-class mission path.
4. **Motion is polite:** flagship motion is width and opacity only; respect
   `prefers-reduced-motion` by dropping the fills' animation, never the
   information.

## 6. Language and microcopy

The console speaks in missions, not in tickets: *launch, prune, steer,
orchestrate, deploy.* Error text names the fix, not the failure —
`provider "mistral" has no API key — paste one in settings` is the standard,
never `error: 401`. Numbers are exact; units take space (`117k tok`,
`$1.2039`); timestamps are local and short. The kanji 進軍 appears in the
brand lockup and the empty state — nowhere else. English elsewhere, plain.

## 7. Amending the language

1. Tokens change in `tokens.css` first — all three themes in the same edit.
2. A new color starts as a semantic name with a documented meaning; if it
   cannot be named, it does not exist.
3. The gallery is the review surface: any change lands with the gallery
   proving it in every theme. What the operator cannot see in the preview,
   the operator cannot trust in the console.
4. This document records intent; `tokens.css` records truth. When they
   disagree, the file wins and this guide gets a fix.
