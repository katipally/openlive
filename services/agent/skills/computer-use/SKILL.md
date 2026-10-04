---
name: computer-use
description: Use before operating an app on the user's computer, such as clicking, filling a field, reading a window or moving through a website in their browser.
license: Apache-2.0
metadata:
  source: Adapted in part from Orca (https://github.com/stablyai/orca), MIT. See THIRD_PARTY_NOTICES.
---

# Working in apps on the user's computer

You see an app through its accessibility tree: every control numbered, with a
picture of the window after it. You act on those numbers. Work in short loops:
look, act once, read what came back, then decide the next step.

## The rules that never bend

- Do not send, submit, buy, delete, or change account settings unless the user
  asked for exactly that. When a step would do one of these and they did not
  ask, stop and ask.
- Password managers are off limits. Do not open, read or fill from them.
- Never tell the user something was sent, saved, bought or deleted unless the
  window's state shows it.

## 1. Look first

Call `get_app_state` with the app before any action. Name the app by its name
or its id from `list_apps`. Without one you get the window in front that is
not OpenLive's own.

- More than one window? `list_windows`, then pass `window_id`.
- Only need the controls? Pass `screenshot: false`. The tree alone is faster.
- App not running? `open_app`. A web page? `open_url` is one call and cannot
  miss; prefer it over typing into the address bar.
- Still loading? `wait` (a second or two), which looks again. Never guess what
  a page probably says by now.

## 2. Act on meaning, not pixels

In order of preference:

1. `set_value` with an element number, for a text field, search box, slider or
   checkbox. It replaces the whole value and is the surest way to fill a field.
2. `click` with an element number. It presses through accessibility when it
   can, which works even when the window is behind another.
3. `perform_action` with an action the element lists under "Secondary
   Actions", such as opening a menu or expanding a row.
4. `type` after clicking into a field, only when `set_value` cannot reach it.
   Pass `paste: true` for long text; the clipboard is put back after.
5. `keypress` for shortcuts, as `["cmdorctrl", "s"]`. `cmdorctrl` is Cmd on a
   Mac and Ctrl elsewhere.
6. `x` and `y` from the latest picture, only when no element fits (a canvas, a
   map, a game). Use the coordinates of the picture you were given.

Window positions from `list_windows` are desktop coordinates for the window
tools. They are never a place to click.

For putting the user's own words into their document, use `insert_text`, not
`type`.

## 3. Verify by reading back

Every action answers with the window's new state. Read it before the next
step. The result also says how sure it is:

- "Done (...), and read back" means the change was checked.
- "The element's own action ran" or "Input was posted" means nothing confirmed
  it. The state below is the only evidence. If it does not show the change,
  the step did not work: look again and try another way.

After a form or a multi-step task, read the final state and say what it shows,
not what you meant to do.

## 4. Stale element numbers

Element numbers belong to the state they came from. Any action, a page load or
a menu opening renumbers them. So:

- Only ever use numbers from the latest state.
- If an action fails with an unknown or wrong element, or the state looks
  different from what you expected, call `get_app_state` again and find the
  element by its label, not its old number.
- If the same step fails twice, change approach (another element, a keyboard
  shortcut, a menu) rather than repeating it.

## 5. When to use read_screen_text

The tree carries most text. Use `read_screen_text` (OCR) only for text the tree
does not have: a canvas, an image, a PDF rendered as pictures, a remote desktop
or a video. Its positions are in the picture's space, which is what `click`
takes as `x` and `y`.

## Browsers

- To go to an address: `open_url` first. Already in the browser and need its
  own tab? `set_value` on the address field, then `keypress` `["Return"]`.
- Web pages show up in the tree like any app. Find fields by their labels.
- After a click that loads a page, `wait`, then read the new state.
- Chromium browsers and Electron apps on Linux show their controls only when
  started with `--force-renderer-accessibility`. If the tree is empty, say so
  and use the picture.

## Per system

**macOS.** The helper needs Accessibility and Screen Recording for "OpenLive
Computer Use". Without Screen Recording there is no picture, but the tree still
works.

**Windows.** An app running as administrator cannot be driven from a normal
app (UIPI). The tool says so. Tell the user, and suggest they reopen the app
without admin rights or do that step themselves. Windows may refuse keystrokes
to a window it keeps in the background; activate the window first.

**Linux.** Controls come from the accessibility bus (AT-SPI). Apps open before
accessibility was switched on need a restart. On Wayland the picture is often
the whole screen, not one window, and on sway, Hyprland and other wlroots
desktops controls can be pressed but clicks and keys cannot be posted. Prefer
element actions there.

## When to stop and ask

- A login, a captcha, a payment or a permission dialog appears.
- The next step would send, submit, buy, delete or change a setting the user
  did not ask for.
- You tried two different ways and the state still does not show the change.

Say plainly what you see and what you need from them.
