# OpenLive design system

One kit, one set of tokens, one motion system. If a screen needs something the
kit does not have, add it to the kit (see the end of this page), then use it.

| What | Where |
| --- | --- |
| Tokens (colour, type, radius, spacing, shadow, blur, z-index, duration, easing) | `apps/web/src/app/globals.css` |
| Motion tokens (springs, fades, stagger) | `apps/web/src/lib/motion.ts` |
| Components and class helpers | `apps/web/src/components/ui`, imported from `@/components/ui` |
| The guard rail | `apps/web/src/design.lint.test.ts`, part of `pnpm test` |

## Principles

- **One look at a time.** Glass (macOS vibrancy, Windows 11 acrylic) or Flat,
  set on `<html data-look>`, crossed with light or dark (`.dark`). Windows 10
  and Linux are Flat only. Components never branch on the look; they read
  tokens, and the tokens change per look.
- **Apple HIG thinking.** Hierarchy from surface shifts and soft shadows, not
  boxes of borders. Every button is a capsule. Nested corners are concentric.
- **Whitespace.** Sections breathe (`--spacing-section`), rows are generous
  (`min-h-row`), and small text is quiet rather than cramped.
- **Adaptive.** No fixed pixel layouts. Sizes are rem tokens, lists survive zero
  and thousands of rows, long text wraps or truncates with a tooltip.

## Tokens

Values live in `globals.css`; this is what each is for. Each is a Tailwind
utility (`bg-card`, `text-label`, `rounded-lg`, `shadow-pop`, `z-modal`,
`duration-base`, `ease-standard`).

| Token | Purpose |
| --- | --- |
| `background`, `surface`, `surface-raised`, `card`, `elevated`, `popover` | The surface ladder, page to popover |
| `float` (via `surface-float`) | Anything floating over app content: dialogs, toasts, the floating panel |
| `foreground`, `muted-strong`, `muted-foreground`, `faint` | Text, strongest to quietest; all clear 4.5:1 on every surface |
| `border`, `border-heavy`, `hairline` | Dividers, emphasised edges, the rim of a floating surface |
| `accent`, `accent-soft`, `link-foreground` | The one accent, its tint, and accent as words |
| `arc`, `arc-soft`, `arc-text` | Warning / attention fill, tint, and as words |
| `destructive`, `destructive-fill`, `destructive-text`, `success`, `success-text` | Status fills and their text-safe siblings |
| `track`, `thumb`, `control`, `secondary`, `chip` | Kit fills: recessed tracks, thumbs, fields, secondary buttons, chips |
| `tooltip`, `tooltip-foreground` | The inverted tooltip |
| `scrim` (utility) | The one dim behind a modal; blurs under glass |
| `text-micro` to `text-display` | The only font sizes |
| `rounded-sm/md/lg/xl`, `rounded-full` | sm marks and menu items, md fields and tracks, lg cards and menus, xl panels and sheets, full buttons |
| `h-control-sm/field/control-md/control-lg`, `min-h-row`, `px-card-x` | Control heights (28/32/36/44), list rows, card padding |
| `gap-beat`, `gap-turn` (and `pt-`) | The timeline's one rhythm: a beat within a turn, a turn between speakers (in-call Activity and Flow sessions) |
| `pl-traffic-lights`, `pr-window-controls` | Clearing the frameless window's own chrome |
| `shadow-xs/card/pop/track/thumb/rim/primary/mark` | Elevation, recess, and the outline of an empty checkbox or radio |
| `--surface-blur`, `--scrim-blur` | Backdrop blur, none in Flat |
| `z-nav` up to `z-window` | The one layering ladder (below) |
| `duration-press/fast/base/settle/look/slow/spring/meter`, `ease-standard/out-quart/settle/spring` | CSS motion; `meter` follows a level or progress reading |

Add a token only when a real need repeats. A one-off is a sign the kit is
missing something.

## Components

Everything below comes from `@/components/ui`.

| Component | Use it for | Props and variants |
| --- | --- | --- |
| `Button`, `buttonClass()` | Every button, and a link that must look like one | `variant` primary, secondary (default), ghost, accent (Undo, Retry), destructive; `size` sm, md, lg; `icon` for a circle (give it `aria-label`) |
| `ConfirmButton` | A delete that asks once in place | `label`, `confirm`, `onConfirm`; `icon` rests as an icon circle; `role="menuitem"` inside a menu |
| `linkClass` | A word you press inside a sentence | class string |
| `Input`, `Textarea` | Text fields | `size` sm, field, md, lg; `invalid`; `icon`, `trailing`; `type="search"` is recessed |
| `Select`, `fieldTrigger` | A native dropdown (long lists, OS keyboard) and its closed look | native `<select>` props |
| `SearchSelect` | A dropdown you type to filter | `options` with `hint` |
| `Menu`: `useMenu`, `menuPanel`, `menuItem`, `menuLabel`, `MenuCheck` | Popover menus and listboxes | `useMenu(root, panel)` handles open, keys, Esc |
| `Segmented` | A choice of 2 to 5 short options | `options`, `size`, `wrap`, `unavailable` greys one out with a reason, `count` beside a label |
| `Switch`, `Checkbox`, `Radio`, `RadioGroup` | On/off, multi and single choice | `Switch` for settings that apply at once |
| `Slider`, `Range` | A labelled setting value; a bare track (seek bar) | `commitOnRelease` for slow writes; `small` thumb |
| `Chip`, `Badge`, `pill` | A status capsule with a dot; a tag beside a title; a capsule you press | `dot` success, arc, accent, muted, danger; `tone` neutral, accent, arc, danger |
| `Notice`, `notice()` | A tinted note in the page (a missing key, a slow path, an error) | `tone` warning (default), danger, info; `notice(tone, true)` on a button |
| `ListGroup`, `ListRow`, `groupLabel` | Settings-style grouped rows; the small-caps heading | `label`, `detail`, `asLabel` |
| `SidePanelHeader`, `sidePanel()` | A panel's header (title, detail line, icon buttons); the panel surface | `sidePanel(true)` floats: dialogs, sheets, the palette |
| `Tooltip` | Every tooltip | `label`, `keys` for a shortcut, `truncated` to show only when cut off |
| `Disclosure`, `Advanced` | An animated collapsible body; the "Advanced" fold in settings | caller owns `open`; `Advanced` remembers per `id` |
| `Swap` | One icon turning into another | `id` changes to swap |
| `Keycap` | A key in a shortcut | |

## Layering and overlays

```
z-window    frameless window controls
z-toast     toasts, tooltips
z-banner    connection banner
z-modal     blocking modals (permission, elicitation, a Flow session)
z-palette   command palette, shortcuts sheet
z-tour      spotlight tour
z-settings  full-window Settings
z-drawer    Sessions drawer (z-drawer-scrim under it)
z-overlay   in-call popovers and side panels
z-stage     the call setup and the call
z-nav       the mode switch
```

- The page's layers carry `data-layer` (view, stage, drawer). A full-window
  surface declares what it covers with `data-covering` (stage or settings), so
  under glass the covered layers stop painting. A modal that must stay above
  Settings adds `ol-over-settings`.
- Every overlay floats on the one recipe: `sidePanel(true)` (or `surface-float`
  with `border border-hairline shadow-pop`), over `scrim`. Never `bg-popover`
  plus a blur by hand.
- z-index is a token, or a small local step (`z-0` to `z-30`) inside a component.

## Motion

- One system: motion/react with the tokens in `lib/motion.ts`. SNAPPY for
  presses and toggles, SMOOTH for menus and panels, GENTLE for layout, FADE for
  what appears in place, EXIT for what leaves, SHEET for a full-height slide,
  `staggerDelay(i)` for a first reveal. Read them through `useMotionTokens()`,
  which honours Reduce Motion.
- CSS transitions use the `duration-*` and `ease-*` tokens. No `duration-300`,
  no `{ duration: 0.3 }`.
- Animate only transform and opacity. GSAP is only for the Flow orb.

## Performance

- Nothing re-renders while idle. High-rate updates (levels, meters) go through
  refs and transforms, not state.
- Long lists: memoized rows plus `ol-cv` (content-visibility) instead of a
  virtual list; group and adapt data in one O(n) pass (`lib/live/timeline.ts`,
  `lib/flow/sessionTimeline.ts`).
- Covered surfaces pause their work (orbs, canvases).

## Accessibility

- An icon button has `aria-label`. Its explanation is a `Tooltip`, never a
  native `title=`.
- A control that explains why it is unavailable uses `aria-disabled`, not
  `disabled`, so the tooltip still shows.
- Text meets 4.5:1 on every surface in both themes and looks; use the `*-text`
  tokens for status in words.
- Keyboard: every menu and dialog traps focus, closes on Esc, and returns focus.
  A dialog opens with focus on itself (`lib/useFocusTrap.ts`), not its first
  control, so a mouse user sees no ring or tooltip on Close; a control that
  should take focus instead (a search field) carries `data-autofocus`.
- Tooltips open on focus only when the keyboard moved it (`components/ui/focus.ts`),
  never on focus a script moved.

## Adding a component

1. Check the table above; extend a variant before adding a component.
2. Put it in `apps/web/src/components/ui/Name.tsx`, built only from tokens, and
   export it from `components/ui/index.ts`.
3. Give it a short header comment: what it is for and when not to use it.
4. Add it to the table on this page.
5. Run `pnpm test`: the design lint fails on raw colours, hand-picked values,
   raw durations, native controls outside the kit, and a local component that
   shadows a kit one. An exception goes in its `ALLOW` list with the reason.
