# What OpenLive shares

OpenLive can share anonymous usage data with the project: which features get used, what fails and how fast things run. This page lists every event the app can send and every field inside one. If a value is not on this page, the app does not send it. For what this means for your data in plain English (why, where it is stored, your choices), read the [privacy policy](PRIVACY.md).

```
 stays on your machine                   can be sent
 ---------------------------------       ---------------------------------
 your voice and audio                    which feature ran, and how often
 what you say, type or ask               fixed labels from the lists below
 files, folders, clipboard, screen       counts and rounded timings
 window titles, names, API keys          app version, OS family and version
 model ids, error messages
```

## The short version

- Shared: which features get used, errors and speed, as numbers and fixed labels.
- Never shared: what you say or type, your files, names, keys, window titles, model ids or error text.
- On by default, with a notice on first run. Nothing is sent until that notice has been shown.
- Turn it off in Settings > Privacy, or set `OPENLIVE_TELEMETRY=0` or `DO_NOT_TRACK=1`.
- Turning it off in the app sends one last anonymous event, then nothing. An environment variable sends nothing at all.
- Now and then a small card asks how a session went or how likely you are to recommend OpenLive. It is rare, takes one tap, has no text box and can be silenced for good. See [Feedback prompts](#feedback-prompts).
- Development builds, builds you compile yourself and any build without release settings send nothing.

## What is never sent

Every field is one of four things: a label from a fixed list on this page, true or false, a number with a cap, or an app version. There is no free text field, so a sentence you said or typed cannot end up in an event. The app checks each event against this list before it stores it, and drops anything that does not match.

The provider or coding agent you picked goes out as a fixed id such as `anthropic` or `claude-code`. The model is never named.

## When sending starts

The first time the app shows its window, it shows a short notice about this page. Nothing is sent until that notice has been on screen. Until then, events wait in memory and are never queued on disk. Before the notice the app writes only a small state file, `telemetry.json` in the `state` folder of the OpenLive folder (`~/.openlive/state/` on macOS and Linux, `%USERPROFILE%\.openlive\state\` on Windows): a random install ID, when it first ran, its version, your on or off choice, what the feedback prompts remember (when one last showed and whether you said don't ask again, kept on your computer and never sent), and the two labels `app_first_open` still owes so it can go out after a restart. No event is queued. A launch at login with no window does not count as showing the notice.

## How long it is kept

Events are kept on the analytics server for 24 months, then a monthly job deletes them. The [privacy policy](PRIVACY.md#how-long-it-is-kept) has the details, including backups.

## Turning it off

- In the app: Settings > Privacy > Share anonymous usage.
- Before the app starts: set `OPENLIVE_TELEMETRY=0` or `DO_NOT_TRACK=1`. Any value of `OPENLIVE_TELEMETRY` other than empty, `1`, `true` or `on`, and any value of `DO_NOT_TRACK` other than empty, `0` or `false`, also counts as opting out. Capital letters do not matter.

Turning the switch off, in Settings or with **Turn off** on the first-run notice, throws away anything still waiting to be sent, sends one last event named `telemetry_disabled`, and then sends nothing. Your install ID and [anonymous name](#username) are deleted afterwards, and Settings shows them gone at once. That event carries the `username` common property like every event, so a deletion request can still find it, but it never asks the server for a named profile: someone who has just said no does not get one. If you opt out with an environment variable, or before the notice was ever shown, nothing is sent at all, not even that event.

If the app cannot write your choice to its state file, it leaves an empty marker file, `telemetry-off`, beside it. While that file exists sharing stays off at every launch, and it is removed when you turn sharing on again and the state file takes that.

The app reads these variables once at launch, from the environment it starts in. A launch from the Dock, Finder or the Start menu does not see a variable you exported in a shell, so start the app from that shell or use the switch in Settings.

The Privacy page is part of the desktop app. In a build that never sends (see below), it says so instead of offering a switch.

## Install ID

The first time an install runs, it picks a random ID (a UUID). It is stored on your computer and is not derived from your hardware, account, name or network. It is used to count active installs and to see whether people come back.

Settings > Privacy shows the last four characters of the ID and your [anonymous name](#username). Turning sharing off deletes the ID, and turning it back on creates a new one and a new name. `app_first_open` is not sent again.

## Username

Every install gets a random, readable name, so its usage can be found and followed on the analytics dashboard: an adjective, an animal and eight hex characters, like `swift-otter-1a2b3c4d`. Nobody types or chooses it, and nothing about you goes into it. It is worked out from the install ID and not stored anywhere, so turning sharing off and on gives a new name. Settings > Privacy shows it, read-only, with a Copy button and a **Request deletion** row that opens a draft email to privacy@openlive.dev carrying only this name. The app sends nothing itself, you send the email. Turning sharing off deletes the name, so copy it first if you want events already sent to be deleted. The [privacy policy](PRIVACY.md#your-rights) says how requests are handled.

- **How it is made.** The words come from two fixed lists of over 200 words each, picked with a hash of the install ID. The eight characters are the first eight of the install ID. That is about 47 bits: among 10,000 installs the chance that two share a name is about 1 in 3.7 million, and among 100,000 about 1 in 37,000. The install ID itself stays unique either way.
- **What is sent.** The name goes out as the `username` [common property](#common-properties) on every event. Once per launch, the first event the server takes also asks it to file the install's profile under that name, so the dashboard lists the profile by name instead of as anonymous. That request uses the same placeholder address as every event, so no city or country is stored with the profile, and the name is all it holds.
- **Finding an install.** Filter events by `username`, or search the profile list for the name or its last eight characters.

## What goes with each event

Every event carries the [common properties](#common-properties) below, the install ID (as the profile ID, with a device ID made from it), and a timestamp rounded down to the minute. The app sends nothing but these events: there is no separate sign-up or registration request.

Events wait in a small queue on disk, `telemetry-queue.jsonl` beside the state file (about 500 events or 256 KB at most, oldest dropped first), so a restart or a spell offline loses little. They are sent slowly, at most two a second. The first send waits a random 15 to 60 seconds after the first-run notice appears, so there is time to turn sharing off before anything goes out. On later launches it waits a random 0 to 60 seconds.

## Where events go, and location

Events go over HTTPS to the OpenLive analytics server. Its address is set when a release is built, not written in the source code.

OpenLive does not ask for your location. Each event carries a placeholder address (`127.0.0.1`) in place of an IP address, so the server does not store a city or coordinates for it. The request still travels over the internet like any other, so the server and the networks in between can see that your connection made it, along with the ordinary request headers, such as a user agent.

## Builds that send nothing

A development build, a build you compile yourself, a build made without the release settings, and an app started with a debugger flag send nothing. They create no install ID and no queue. Only the project's own release builds report.

## Crashes and bug reports

OpenLive has no crash reporter and never uploads logs. The crash events below only count that a crash happened. For detail, use Settings > Privacy > Report a problem. It opens a GitHub issue that you write and submit yourself, with only the OpenLive version, your OS name and version, the provider id and the last Flow failure code filled in.

## Feedback prompts

OpenLive sometimes asks how it is doing, so the project can tell whether a change helped. There are two prompts, both a small card in the corner of the main window, never a dialog. Neither takes focus, blocks anything or asks during a Flow session or a call, and each goes away by itself if ignored.

- **How was that?** A thumbs up or down after a Flow session or a call in which at least two turns were answered. A thumbs down offers one row of fixed reasons to tap. There is no text box. After a call it appears when you are back on the main window. After Flow it appears the next time the main window is shown, within 12 hours of the session.
- **How likely are you to recommend OpenLive to a friend?** One question, 0 to 10, on the main window only. Asked once the install has been used on at least 7 different days and has had its first answered request, then at most every 90 days.

Every limit is enforced in one place in the app and remembered in a small file on your computer:

| Limit | Value |
| --- | --- |
| Never in the first | 2 days after the app first ran |
| At most one prompt of any kind per | 7 days |
| A session rating at most once per | 7 days |
| The 0 to 10 question at most every | 90 days |
| Two prompts on the same day | never |
| After 2 prompts in a row that were dismissed or ignored | nothing for 30 days |
| Every prompt has | a "Don't ask again" button, honored for good |

Nothing is ever asked while sharing is off or before the first-run notice has been shown, since an answer could not be sent anyway. Turning sharing off clears any prompt that was waiting. Settings > Privacy > Ask for feedback shows the "Don't ask again" choice and lets you change it.

Each prompt sends at most one [`feedback_given`](#feedback_given) event, at most one a day. An answer, a dismissal, an auto-hide and "Don't ask again" are each a value of its `outcome`, so the share of prompts people answer can be told from the prompts they skipped. The session's length, words and content are never sent: only the brain that answered (as in `brain_error`) and how many turns it took, in four buckets.

## How to read this page

Events are grouped by topic. Each one has when it fires, a limit and a table of its properties.

- **Sent** is `always`, or `sometimes` when the field is left out because it does not apply or was not measured.
- **Values** are fixed labels, true or false, or a number with its range. Numbers are rounded as shown. A number outside its range is dropped, not sent, except session lengths, uptime, days since first run and summed counts, which stop at the top of their range.
- **Limit** is how often the app allows the event. "Per launch" means each time the app starts. An event without a cap says none.
- Long lists of labels sit at the end, under [Lists used above](#lists-used-above), and the Values cell links to them.

`flow_session` and `call_session` are put together on your computer from small counts collected while the session runs. Only the finished summary is sent.

## Common properties

Added to every event.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `app_version` | The OpenLive version. | version number, like 1.2.3 or 1.2.3-beta.1 | always |
| `platform` | The OS family: `darwin` is macOS, `win32` is Windows. | `darwin`, `win32`, `linux` | always |
| `arch` | The CPU architecture the app runs on. | `arm64`, `x64` | always |
| `arch_translated` | True when the app runs under translation on an ARM computer, such as Rosetta on a Mac. | true or false | always |
| `os_major` | The major OS version: 15 for macOS 15, 10 or 11 for Windows. Linux is always `linux`, never a distro name. | one or two digits (a major version, like 15), or linux | always |
| `username` | The install's random [anonymous name](#username), made from the install ID. | adjective, animal and eight hex characters, like swift-otter-1a2b3c4d | always |

## Lifecycle events

Starting, using and quitting the app.

### `app_first_open`

The first time an install runs. Like every event, it waits until the first-run notice has been shown.

Limit: once per install.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `origin` | `fresh` for a new install. `existing_install` when OpenLive was already on this computer before it could share usage, so upgrades can be told from new installs. The app only checks whether its own data files exist, never what is in them. | `fresh`, `existing_install` | always |
| `launch_kind` | `login` when the app started by itself at login, `manual` when you opened it. | `manual`, `login` | always |

### `app_launch`

At the end of every start, whether it worked or not.

Limit: at most 1 per launch.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `launch_kind` | `login` when the app started by itself at login, `manual` when you opened it. | `manual`, `login` | always |
| `boot_result` | `ok`, `ports_blocked` when another program held a port OpenLive needs, or `servers_timeout` when its local servers did not come up in time. | `ok`, `ports_blocked`, `servers_timeout` | always |
| `boot_ms` | Time from the app starting until both local servers answered, to 100 ms. Only sent after a good start. | whole number, 0 to 600000, rounded to 100 | sometimes |
| `agent_port_moved` | True when the local agent server had to use a different port than usual. | true or false | sometimes |
| `prev_exit_clean` | False when the previous run did not exit cleanly. | true or false | sometimes |
| `login_item` | Whether OpenLive is set to open at login. | true or false | sometimes |
| `linux_session` | The display server on Linux. `n/a` on other systems. | `x11`, `wayland`, `n/a` | sometimes |
| `look` | The window look in use. | `glass`, `flat` | sometimes |
| `glass_blocked_by` | Why the glass look is not available. `none` when nothing blocks it. | `none`, `unsupported-os`, `no-gpu`, `reduce-transparency`, `slow` | sometimes |
| `theme` | The theme setting. | `system`, `light`, `dark` | sometimes |

### `app_active_day`

The first real action of each local day: focusing the OpenLive window, opening Flow, opening the window from the tray or dock, or starting a call. A launch at login with no interaction does not count. The date itself is not sent.

Limit: at most 1 per day.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `first_surface` | Where that first action happened. | `main_window`, `flow`, `call`, `tray` | always |

### `app_updated`

At launch, when the app version differs from the one that ran last. In practice, once after an update.

Limit: at most 1 per launch.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `from_version` | The version before the update. | version number, like 1.2.3 or 1.2.3-beta.1 | always |
| `to_version` | The version now running. | version number, like 1.2.3 or 1.2.3-beta.1 | always |

### `update_result`

As an update moves along: found, downloaded, the restart choice you made, an up-to-date answer to a check you asked for, or a failure. A background check that finds nothing sends nothing. A check you asked for and a background check are counted apart, so a failure from the menu is not lost to the one at launch.

Limit: at most 1 per day for each combination of `stage` and `error_kind` and `manual`.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `stage` | Where the update is: `restart_now` and `restart_later` are your choice in the restart dialog. | `available`, `downloaded`, `restart_now`, `restart_later`, `up_to_date`, `failed` | always |
| `to_version` | The version on offer. Left out for `up_to_date` and `failed`. | version number, like 1.2.3 or 1.2.3-beta.1 | sometimes |
| `manual` | True when you asked for the check from the menu. | true or false | sometimes |
| `error_kind` | Why an update failed, as a category. The error text is never sent. | `feed_missing`, `asset_missing`, `signature_invalid`, `network`, `other` | sometimes |

### `app_quit`

When OpenLive quits.

Limit: at most 1 per launch.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `via` | How it quit: from the tray menu, the app menu, to install an update, with no tray to quit from, at OS shutdown, after a failed start, or another way. | `tray_menu`, `app_menu`, `update_restart`, `no_tray`, `os_shutdown`, `boot_failed`, `other` | always |
| `uptime_h` | How many hours the app had been running, to 0.1. | number, 0 to 999, rounded to 0.1 | sometimes |

## Session events

One summary per Flow session and per call.

### `flow_session`

Each time Flow's orb closes. One event covers one time the orb was open. A double tap by accident shows up as a session with 0 turns. The orb up for Dictate alone is not a Flow session and sends nothing.

Limit: none.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `brain_kind` | `api` for a model provider, `acp` for a coding agent. | `api`, `acp` | sometimes |
| `brain_id` | Which provider or coding agent. Never the model. | one of the [provider ids](#provider-ids) or [coding agent ids](#coding-agent-ids) | sometimes |
| `duration_s` | How long the orb was open, in seconds. | whole number, 0 to 86400 | always |
| `ended_by` | What closed it: `gesture` (the double tap), `orb_button`, `idle` (Close after silence ran out), `disarmed` (Flow was switched off on its home), `sleep_or_lock` (the computer slept, or the screen locked while End Flow and calls when the screen locks is on), `dictate_opened` (Dictate was opened over it), `quit`, or `other`. | `gesture`, `orb_button`, `idle`, `disarmed`, `sleep_or_lock`, `dictate_opened`, `quit`, `other` | always |
| `opened_by` | What opened it: `gesture` (the double tap), `carry_on` (continuing an earlier session), `tray_new` (Start Flow in the tray, whether the orb was closed or already open), or `late_speech` (a sentence that finished transcribing after the orb had closed). | `gesture`, `carry_on`, `tray_new`, `late_speech` | sometimes |
| `ready` | Whether Flow was ready to listen: `ok`, `no_brain` (no provider or coding agent set up), or `mic_failed` (the microphone did not open). | `ok`, `no_brain`, `mic_failed` | sometimes |
| `ready_ms` | Time from the open gesture until the microphone was ready, to 10 ms. | whole number, 0 to 600000, rounded to 10 | sometimes |
| `turns` | Finished turns: Flow heard you, worked and answered. | whole number, 0 to 999 | always |
| `acted` | True when Flow acted on the computer: typed, pressed keys, moved the pointer or clicked, moved a window, opened an app or link, or ran a shell command. Worked out from the tool counts below, so it is always sent. | true or false | always |
| `consent` | Whether you had allowed Flow to act on the computer when the session closed. | true or false | sometimes |
| `lang` | The language of the last thing you said in the session. | one of the [languages](#languages) | sometimes |
| `steered` | Times you spoke while Flow was still working, and it folded the new sentence into the same turn. | whole number, 0 to 999 | sometimes |
| `quiet_turns` | Turns answered as text on screen instead of aloud, because Flow chose to stay quiet. | whole number, 0 to 999 | sometimes |
| `stops` | Times you pressed Stop. | whole number, 0 to 999 | sometimes |
| `barge_ins` | Times you spoke over Flow's voice to interrupt it. | whole number, 0 to 999 | sometimes |
| `top_quiet_reason` | Why Flow stayed quiet most often: a meeting or call, another app using the microphone, Do Not Disturb, a muted output, or the Speak replies setting being off. `none` when no turn was quiet. | `none`, `meeting`, `mic_busy`, `dnd`, `output_muted`, `off` | sometimes |
| `tool_calls` | Tool calls Flow's brain made. Each counts once, whichever brain answered. | whole number, 0 to 999 | sometimes |
| `tool_errors` | Tool calls that failed. | whole number, 0 to 999 | sometimes |
| `t_insert` | Tool calls that put text at your cursor. | whole number, 0 to 999 | sometimes |
| `t_words` | Tool calls that read the selection, used the clipboard or read the front app's context. | whole number, 0 to 999 | sometimes |
| `t_see` | Tool calls that looked at the screen or camera: screenshots, screen text, waiting, listing windows, camera frames. | whole number, 0 to 999 | sometimes |
| `t_point` | Tool calls that used the pointer: click, move, drag, scroll. | whole number, 0 to 999 | sometimes |
| `t_keys` | Tool calls that typed or pressed keys. | whole number, 0 to 999 | sometimes |
| `t_window` | Tool calls that activated, moved, resized, minimized or closed a window. | whole number, 0 to 999 | sometimes |
| `t_open` | Tool calls that opened an app or a link. | whole number, 0 to 999 | sometimes |
| `t_shell` | Tool calls that ran a shell command. | whole number, 0 to 999 | sometimes |
| `t_memory` | Tool calls that saved something to remember. | whole number, 0 to 999 | sometimes |
| `perm_asks` | Permission questions a coding agent asked. | whole number, 0 to 999 | sometimes |
| `perm_allowed` | Asks that were allowed. | whole number, 0 to 999 | sometimes |
| `perm_denied` | Asks that were denied. | whole number, 0 to 999 | sometimes |
| `perm_timeout` | Asks that timed out. | whole number, 0 to 999 | sometimes |
| `perm_auto` | Asks Flow answered for you, because you had already allowed Flow to act. | whole number, 0 to 999 | sometimes |
| `perm_by_voice` | Asks you answered by speaking. | whole number, 0 to 999 | sometimes |
| `failure_cards` | Failure cards the orb showed. | whole number, 0 to 999 | sometimes |
| `fixes_clicked` | Times you pressed the fix button on a failure card. | whole number, 0 to 999 | sometimes |
| `last_failure` | The code of the last failure card, or `none`. | `none`, or one of the [failure codes](#failure-codes) | sometimes |
| `lost_silence` | Turns given up on because no answer came for 90 seconds. | whole number, 0 to 999 | sometimes |
| `lost_link` | Turns lost because the connection to the local agent dropped mid answer. | whole number, 0 to 999 | sometimes |
| `link_drops` | Times that connection had to reconnect. | whole number, 0 to 999 | sometimes |
| `mic_lost` | Times the microphone stopped and could not be recovered. | whole number, 0 to 999 | sometimes |
| `agent_tools` | Tool calls a coding agent made with its own tools. | whole number, 0 to 999 | sometimes |
| `agent_tools_failed` | How many of those failed. | whole number, 0 to 999 | sometimes |
| `errors` | Turns that failed. | whole number, 0 to 999 | sometimes |
| `ttft_ms_p50` | Median time from a turn starting to the first word of the reply, to 10 ms. | whole number, 0 to 600000, rounded to 10 | sometimes |
| `ttft_ms_p95` | The 95th percentile of that time. | whole number, 0 to 600000, rounded to 10 | sometimes |
| `turn_ms_p50` | Median time from a turn starting to it finishing. | whole number, 0 to 600000, rounded to 10 | sometimes |
| `agent_start_ms` | How long starting the coding agent took, to 10 ms. 0 when no coding agent was used. | whole number, 0 to 600000, rounded to 10 | sometimes |
| `agent_restarts` | Times a coding agent had to be restarted. | whole number, 0 to 999 | sometimes |
| `stt_ms_p50` | Median time to turn your speech into text and decide you had finished, to 10 ms. Left out when no turn was measured. | whole number, 0 to 600000, rounded to 10 | sometimes |
| `tts_ms_p50` | Median time from the first word of the reply to the first sound, to 10 ms. | whole number, 0 to 600000, rounded to 10 | sometimes |
| `v2v_ms_p50` | Median voice to voice time, from you finishing to the reply starting, to 10 ms. Pauses OpenLive waits on purpose are not counted. | whole number, 0 to 600000, rounded to 10 | sometimes |
| `v2v_turns` | How many turns those medians were measured over. | whole number, 0 to 999 | sometimes |
| `stt_family` | The speech-to-text engine family in use. Never the variant or a voice. | one of the [speech-to-text families](#speech-to-text-families) | sometimes |
| `tts_family` | The text-to-speech engine family in use. Never the variant or a voice. | one of the [text-to-speech families](#text-to-speech-families) | sometimes |
| `webgpu` | Whether WebGPU was available for the on-device voice models. | true or false | sometimes |

In Flow, the `perm_*` counts come only from a coding agent's own permission questions. The question that asks whether Flow may act on your computer is not counted there: it is reported as [`flow_consent_result`](#flow_consent_result).

### `call_session`

When a call ends. One event per call.

Limit: none.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `brain_kind` | `api` for a model provider, `acp` for a coding agent. | `api`, `acp` | sometimes |
| `brain_id` | Which provider or coding agent. Never the model. | one of the [provider ids](#provider-ids) or [coding agent ids](#coding-agent-ids) | sometimes |
| `duration_s` | How long the call lasted, in seconds. | whole number, 0 to 86400 | always |
| `ended_by` | What ended it: `end_button` (the End button or its shortcut), `orb_end` (End on the orb), `window_closed`, `sleep_or_lock` (the computer slept, or the screen locked while End Flow and calls when the screen locks is on), `start_failed`, `switched_chat`, `app_quit`, or `other`. | `end_button`, `orb_end`, `window_closed`, `sleep_or_lock`, `start_failed`, `switched_chat`, `app_quit`, `other` | always |
| `start_result` | How the start went: `ok`, `mic_denied` (microphone access was refused), or `start_failed`. | `ok`, `mic_denied`, `start_failed` | sometimes |
| `start_ms` | Time from pressing Start until the call was ready, to 10 ms. | whole number, 0 to 600000, rounded to 10 | sometimes |
| `turns` | Finished turns. | whole number, 0 to 999 | always |
| `typed_turns` | Turns you typed instead of said. | whole number, 0 to 999 | sometimes |
| `interrupted` | Times a reply was cancelled before it finished. | whole number, 0 to 999 | sometimes |
| `barge_ins` | Times you spoke over the assistant to cut in. | whole number, 0 to 999 | sometimes |
| `lang` | The session language of the last turn. | one of the [languages](#languages) | sometimes |
| `camera_used` | True if the camera was on at any point. | true or false | sometimes |
| `screen_used` | True if screen sharing was on at any point. | true or false | sometimes |
| `ptt_used` | True if push to talk was used. | true or false | sometimes |
| `has_folder` | Whether a project folder was set for the call. Never the path. | true or false | sometimes |
| `mic_lost` | Times the microphone went away during the call, and OpenLive switched to the default one. | whole number, 0 to 999 | sometimes |
| `camera_failed` | Times turning the camera on did not work, because access was refused or no camera could be opened. | whole number, 0 to 999 | sometimes |
| `screen_failed` | Times turning screen sharing on did not work, because it was cancelled or refused. | whole number, 0 to 999 | sometimes |
| `t_look` | Uses of the look tool, which grabs a sharp frame on demand. | whole number, 0 to 999 | sometimes |
| `t_clipboard` | Clipboard reads and writes. | whole number, 0 to 999 | sometimes |
| `t_open_url` | Links opened. | whole number, 0 to 999 | sometimes |
| `t_files` | File tools: list, read, write and edit files in the project folder. | whole number, 0 to 999 | sometimes |
| `t_web` | Web research handed to OpenLive's helper: searches and page fetches. | whole number, 0 to 999 | sometimes |
| `t_plan` | Updates to OpenLive's to-do list. | whole number, 0 to 999 | sometimes |
| `t_memory` | Things saved to remember. | whole number, 0 to 999 | sometimes |
| `perm_asks` | Permission questions asked in the call, by a coding agent or by OpenLive before one of its tools changes something. | whole number, 0 to 999 | sometimes |
| `perm_allowed` | Asks that were allowed. | whole number, 0 to 999 | sometimes |
| `perm_denied` | Asks that were denied. | whole number, 0 to 999 | sometimes |
| `perm_timeout` | Asks that timed out. | whole number, 0 to 999 | sometimes |
| `perm_by_voice` | Asks you answered by speaking. | whole number, 0 to 999 | sometimes |
| `elicitations` | Questions or sign-in requests (forms and login links) a coding agent put to you. | whole number, 0 to 999 | sometimes |
| `resumed` | For a coding agent: `none` (nothing to resume), `resumed` (the agent picked its own session back up), `loaded` (it loaded and replayed an earlier session), `fell_back` (an earlier session was wanted but a fresh one started). | `none`, `resumed`, `loaded`, `fell_back` | sometimes |
| `link_drops` | Times the connection to the local agent had to reconnect. | whole number, 0 to 999 | sometimes |
| `agent_tools` | Tool calls a coding agent made with its own tools. | whole number, 0 to 999 | sometimes |
| `agent_tools_failed` | How many of those failed. | whole number, 0 to 999 | sometimes |
| `errors` | Turns that failed. | whole number, 0 to 999 | sometimes |
| `ttft_ms_p50` | Median time from a turn starting to the first word of the reply, to 10 ms. | whole number, 0 to 600000, rounded to 10 | sometimes |
| `ttft_ms_p95` | The 95th percentile of that time. | whole number, 0 to 600000, rounded to 10 | sometimes |
| `turn_ms_p50` | Median time from a turn starting to it finishing. | whole number, 0 to 600000, rounded to 10 | sometimes |
| `agent_start_ms` | How long starting the coding agent took, to 10 ms. 0 when no coding agent was used. | whole number, 0 to 600000, rounded to 10 | sometimes |
| `agent_restarts` | Times a coding agent had to be restarted. | whole number, 0 to 999 | sometimes |
| `stt_ms_p50` | Median time to turn your speech into text and decide you had finished, to 10 ms. Left out when no turn was measured. | whole number, 0 to 600000, rounded to 10 | sometimes |
| `tts_ms_p50` | Median time from the first word of the reply to the first sound, to 10 ms. | whole number, 0 to 600000, rounded to 10 | sometimes |
| `v2v_ms_p50` | Median voice to voice time, from you finishing to the reply starting, to 10 ms. Pauses OpenLive waits on purpose are not counted. | whole number, 0 to 600000, rounded to 10 | sometimes |
| `v2v_turns` | How many turns those medians were measured over. | whole number, 0 to 999 | sometimes |
| `stt_family` | The speech-to-text engine family in use. Never the variant or a voice. | one of the [speech-to-text families](#speech-to-text-families) | sometimes |
| `tts_family` | The text-to-speech engine family in use. Never the variant or a voice. | one of the [text-to-speech families](#text-to-speech-families) | sometimes |
| `webgpu` | Whether WebGPU was available for the on-device voice models. | true or false | sometimes |

## Error and crash events

What broke, as a kind and never as text.

### `brain_error`

When a turn fails, in a call or in Flow. Only the kind of failure is sent, never the message. Starting a coding agent just to list its models does not count.

Limit: the same `class` and `brain_id` is not sent again within 5 minutes.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `surface` | Where it happened. | `flow`, `call` | always |
| `brain_kind` | `api` for a model provider, `acp` for a coding agent. | `api`, `acp` | sometimes |
| `brain_id` | Which provider or coding agent. Never the model. | one of the [provider ids](#provider-ids) or [coding agent ids](#coding-agent-ids) | sometimes |
| `class` | The kind of failure. Values starting with `agent_` are coding agent failures, the rest are model provider failures. | `no_key`, `no_model`, `auth`, `model_not_found`, `quota`, `rate_limited`, `unreachable`, `server_error`, `bad_request`, `stream_error`, `other`, `agent_no_folder`, `agent_start_failed`, `agent_start_timeout`, `agent_no_output`, `agent_stalled`, `agent_crashed`, `agent_rejected`, `agent_refused` | always |
| `recovered` | For a coding agent: true when OpenLive restarted it and it came back. | true or false | sometimes |
| `http_class` | `4xx` or `5xx` when the provider answered with an HTTP error, otherwise `none`. | `4xx`, `5xx`, `none` | sometimes |

### `flow_failure_card`

When Flow shows a failure card (the orb's message with a fix button) and its code differs from the last one shown.

Limit: the same `code` is not sent again within 10 minutes.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `code` | What went wrong. See [failure codes](#failure-codes). The card's title and detail are never sent. | one of the [failure codes](#failure-codes) | always |
| `origin` | Where the failure was found: `health` (the readiness check), `turn` (a failed turn), `mic`, `lost_answer`, or `link`. | `health`, `turn`, `mic`, `lost_answer`, `link` | sometimes |
| `brain_kind` | `api` for a model provider, `acp` for a coding agent. | `api`, `acp` | sometimes |
| `brain_id` | Which provider or coding agent. Never the model. | one of the [provider ids](#provider-ids) or [coding agent ids](#coding-agent-ids) | sometimes |

### `crash_detected`

When one of OpenLive's windows or helper processes crashes, and on the next launch after a run that did not exit cleanly. A normal quit is not a crash. `unclean_exit` also shows up after a force quit or a power loss.

Limit: at most 3 per launch.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `source` | What crashed: a window's page process (`renderer`), the `gpu` process, another helper (`utility`), or the previous run of the app itself (`main_previous_run`). | `renderer`, `gpu`, `utility`, `main_previous_run` | always |
| `reason` | Electron's crash reason, or `unclean_exit` for a previous run that did not quit cleanly. | `crashed`, `oom`, `killed`, `abnormal-exit`, `launch-failed`, `integrity-failure`, `memory-eviction`, `unclean_exit` | always |
| `target` | Which window crashed, when it was a window: the OpenLive window, Flow's hidden voice window, the orb, the cursor overlay or the splash screen. `none` for other processes. | `main_window`, `flow_owner`, `flow_orb`, `cursor_overlay`, `splash`, `other`, `none` | sometimes |
| `exit_code` | The process exit code, or -1 when it is not known. | whole number, -1 to 999 | sometimes |

### `service_crashed`

When one of OpenLive's two local servers, the web server or the agent server, exits unexpectedly.

Limit: at most 12 per launch.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `service` | Which server. | `agent`, `web` | always |
| `exit_code` | The exit code, or -1 when it is not known. | whole number, -1 to 999 | sometimes |
| `respawn_n` | Which restart attempt this was within a minute. | whole number, 0 to 99 | sometimes |
| `outcome` | `respawning` (OpenLive restarts it), `gave_up` (it crashed too often), or `port_taken_by_other` (another program now holds its port). | `respawning`, `gave_up`, `port_taken_by_other` | always |
| `uptime_s` | How long the server had been running, in seconds. | whole number, 0 to 604800 | sometimes |

### `main_exception`

When the desktop shell or the agent server hits an error nothing caught. Only the kind is sent, never the message or the stack.

Limit: at most 3 per launch for each `process`.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `process` | Which process. | `main`, `agent` | always |
| `kind` | An uncaught error, or an unhandled promise rejection. | `uncaught`, `unhandled_rejection` | always |

### `renderer_error`

When a page in OpenLive hits a JavaScript error, an unhandled promise rejection or a render crash. Only the kind is sent, never the message, stack or file name. Only the OpenLive window and Flow's hidden voice window report.

Limit: at most 3 per launch for each `surface`; the same `kind` is not sent again within 10 minutes.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `surface` | `main` is the OpenLive window. `owner` is Flow's hidden voice window. | `main`, `owner` | always |
| `kind` | What happened. | `render_crash`, `uncaught`, `unhandled_rejection` | always |
| `during` | What was going on: a call, Flow, or something else. | `call`, `flow`, `other` | sometimes |

### `voice_engine_fault`

When an on-device voice engine's worker crashes, drops an accelerator that misbehaved, or its speed test fails or times out.

Limit: at most 3 per launch for each `engine_family`.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `engine_family` | Which engine family. Never the variant or a voice. | one of the [voice engine families](#voice-engine-families) | always |
| `kind` | `worker_crash`, `accel_fallback` (stopped using an accelerator), `bench_timeout`, or `bench_failed`. | `worker_crash`, `accel_fallback`, `bench_timeout`, `bench_failed` | always |
| `provider` | The accelerator involved. | one of the [acceleration providers](#acceleration-providers) | sometimes |

## Voice and readiness events

How the on-device voice and Flow's permissions are doing.

### `voice_bench_result`

The first time a voice engine's speed test finishes on this computer.

Limit: once per install for each `engine_family`.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `engine_family` | Which engine family. | one of the [voice engine families](#voice-engine-families) | always |
| `engine_kind` | `asr` is speech to text, `tts` is text to speech, `speaker` is the voiceprint, `addressee` is the side talk check. | `asr`, `tts`, `speaker`, `addressee` | always |
| `chosen_provider` | The accelerator the test picked. | one of the [acceleration providers](#acceleration-providers) | always |
| `cpu_rtf` | How fast the CPU ran the engine as a real-time factor: processing time divided by audio length, lower is faster. | number, 0 to 999, rounded to 0.01 | sometimes |
| `chosen_rtf` | The same for the accelerator that was picked. | number, 0 to 999, rounded to 0.01 | sometimes |
| `tier` | A coarse hardware class. | `low`, `mid`, `high` | sometimes |
| `apple_silicon` | Whether this is an Apple silicon Mac. | true or false | sometimes |
| `providers_available` | How many accelerators the computer offered. | whole number, 0 to 9 | sometimes |

### `voice_models_result`

When the on-device voice models finish downloading, or fail. Loading models that are already downloaded sends nothing, unless it fails.

Limit: none.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `trigger` | What asked for the download: `launch_warm` is a background warm-up at launch. | `lobby_button`, `call_start`, `flow_open`, `launch_warm`, `settings` | always |
| `result` | `ok`, `failed`, or `offline` when it failed while the computer had no connection. | `ok`, `failed`, `offline` | always |
| `duration_s` | How long it took, in seconds. | whole number, 0 to 86400 | sometimes |
| `mb` | How much was downloaded, in megabytes, rounded to 10. | whole number, 0 to 99990, rounded to 10 | sometimes |
| `stt_family` | The speech-to-text engine family being loaded. | one of the [speech-to-text families](#speech-to-text-families) | sometimes |
| `tts_family` | The text-to-speech engine family being loaded. | one of the [text-to-speech families](#text-to-speech-families) | sometimes |
| `webgpu` | Whether WebGPU was available. | true or false | sometimes |

### `flow_readiness_changed`

When Flow's readiness changes. It is checked every few seconds and only a change is sent. Never any reason text.

Limit: at most 6 per launch.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `from` | The last state reported, or `unknown` if there was none. | `unknown`, `ready`, `stopped`, `access`, `off` | always |
| `to` | `ready`, `stopped` (the key listener stopped), `access` (a permission is missing), or `off` (switched off or not available). | `ready`, `stopped`, `access`, `off` | always |
| `perm_accessibility` | Whether the OS has granted Accessibility access. | true or false | sometimes |
| `perm_post_events` | Whether the OS lets OpenLive send key presses and clicks. | true or false | sometimes |
| `perm_screen` | Whether the OS has granted screen recording. | true or false | sometimes |
| `perm_microphone` | The OS's microphone permission state. | `granted`, `denied`, `undetermined`, `restricted`, `unknown` | sometimes |
| `linux_session` | The display server on Linux. `n/a` on other systems. | `x11`, `wayland`, `n/a` | sometimes |

### `os_permission_request`

When OpenLive asks the operating system for a permission Flow needs.

Limit: at most 3 per day for each `permission`.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `permission` | Which permission: `post_events` is sending key presses and clicks. | `accessibility`, `microphone`, `screen`, `post_events` | always |
| `granted_now` | The answer at the moment of the prompt, not the state afterwards. On macOS the accessibility and screen answers are usually false, because the grant is not reported at once. The real state shows in [`flow_readiness_changed`](#flow_readiness_changed). | true or false | always |
| `asked_from` | Which screen asked. | `onboarding`, `flow_settings`, `flow_home`, `other` | sometimes |

## Setup and first use events

Where new installs get stuck.

### `onboarding_step`

The first time each step happens on an install. Each step is sent once. The steps are listed under [onboarding steps](#onboarding-steps). `activated` is the first time a turn ended in an answer, in Flow or in a call.

Limit: once per install for each `step`.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `step` | Which step. | one of the [onboarding steps](#onboarding-steps) | always |
| `hours_since_first_open` | Hours since the install first ran, to 0.1. | number, 0 to 99999, rounded to 0.1 | sometimes |
| `tour_exit` | On a `tour_closed_` step only: how the tour ended. `done` is the Done button on the last step, `skipped` is Skip, the close button, Escape or a click outside, and `left` is the screen changing under it: the control it points at went away, or the whole screen closed. | `done`, `skipped`, `left` | sometimes |
| `tour_step` | On a `tour_closed_` step only: the tour step showing when it ended, counting from 1. | whole number, 1 to 9 | sometimes |

### `flow_consent_result`

When Flow asks aloud whether it may act on your computer, and you answer or do not.

Limit: at most 3 per day.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `outcome` | The answer, or `unanswered`. | `granted`, `declined`, `unanswered` | always |
| `brain_kind` | `api` for a model provider, `acp` for a coding agent. | `api`, `acp` | sometimes |

### `lobby_blocked`

When you leave the call setup screen without starting a call because something was missing, after that gap had been showing for at least a second.

Limit: at most 1 per day for each `gap`.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `gap` | What was missing. When several were, the one shown first. | `agent_not_installed`, `agent_signed_out`, `no_api_key`, `folder_missing`, `folder_unset`, `models_not_downloaded`, `no_mic` | always |
| `brain_kind` | `api` for a model provider, `acp` for a coding agent. | `api`, `acp` | sometimes |
| `brain_id` | Which provider or coding agent. Never the model. | one of the [provider ids](#provider-ids) or [coding agent ids](#coding-agent-ids) | sometimes |
| `left_via` | How you left. | `back`, `settings`, `other` | sometimes |

### `agent_action_result`

When installing, updating, uninstalling, signing in to or signing out of a coding agent from Settings ends.

Limit: at most 5 per day for each `agent_id`.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `agent_id` | Which coding agent. | one of the [coding agent ids](#coding-agent-ids) | always |
| `action` | What you asked for. | `install`, `uninstall`, `update`, `login`, `logout` | always |
| `result` | How it ended: `terminal_opened` means a terminal was opened for you to finish in, `npm_eacces` means npm lacked permission to install, `signed_in` means a sign-in was seen completing, `wait_timeout` means OpenLive gave up waiting for it. | `ok`, `failed`, `terminal_opened`, `terminal_launch_failed`, `npm_eacces`, `error`, `signed_in`, `wait_timeout` | always |
| `duration_s` | How long it took, in seconds. | whole number, 0 to 3600 | sometimes |

### `remote_ollama_prompt`

When Settings asks you to confirm an Ollama address that is not on this computer. Never the address itself.

Limit: none.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `outcome` | What happened: you accepted or cancelled the prompt, or saving the address failed. | `accepted`, `cancelled`, `error` | always |
| `scheme` | Whether the address starts with `http` or `https`. | `http`, `https` | sometimes |

## Settings and feature use events

Which settings and features people use.

### `setting_changed`

When you change one of the settings under [reported settings](#reported-settings). Only the setting's name and a fixed value are sent. A changed model goes out as `changed` and a saved key as `added`, never the model id or the key.

Limit: at most 3 per day for each `setting`.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `setting` | Which setting. See [reported settings](#reported-settings), which lists the values each one can take. | one of the pairs in [reported settings](#reported-settings) | always |
| `value` | The new value, which must be one that setting allows. See [reported settings](#reported-settings). | one of the pairs in [reported settings](#reported-settings) | always |
| `subject` | For a setting tied to a provider or a coding agent, which one. `none` when there is none. | `none`, or one of the [provider ids](#provider-ids) or [coding agent ids](#coding-agent-ids) | sometimes |
| `from` | Which screen the change was made from. | `onboarding`, `settings`, `call_setup`, `flow_home`, `other` | sometimes |

### `tray_action`

When you click an item in the tray or menu bar menu.

Limit: none.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `action` | Which item: `new_flow` is Start Flow; `flow_on` and `flow_off` turn Flow on or off; `dictate_on` and `dictate_off` turn Dictate on or off. | `open`, `new_flow`, `flow_on`, `flow_off`, `dictate_on`, `dictate_off`, `allow_accessibility`, `settings`, `quit` | always |

### `feature_usage`

When the app quits, at the next launch for any counts left over, and when the first counted use of a new day happens (the usual path for an app that stays in the menu bar and never quits): how many times you used each counted feature since the last report. The event is dated with the minute of the last count in it, so a day's counts stay on that day. A counter at zero is left out, and nothing is sent when no feature was used. Only counts, never what you searched for, typed or picked.

Limit: at most 3 per day.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `n_settings_open` | Times Settings was opened. | whole number, 0 to 999 | sometimes |
| `n_settings_search` | Settings searches. | whole number, 0 to 999 | sometimes |
| `n_palette_open` | Times the command palette was opened. | whole number, 0 to 999 | sometimes |
| `n_palette_run` | Commands run from the command palette. | whole number, 0 to 999 | sometimes |
| `n_shortcuts_sheet` | Times the keyboard shortcuts sheet was opened. | whole number, 0 to 999 | sometimes |
| `n_history_open` | Times History was opened. | whole number, 0 to 999 | sometimes |
| `n_history_search` | Searches in History. | whole number, 0 to 999 | sometimes |
| `n_history_resume` | Conversations resumed from History. | whole number, 0 to 999 | sometimes |
| `n_history_resume_cli_session` | A coding agent's own sessions resumed from History. | whole number, 0 to 999 | sometimes |
| `n_flow_history_open` | Flow sessions opened from Flow's history. | whole number, 0 to 999 | sometimes |
| `n_flow_history_search` | Searches in Flow's history. | whole number, 0 to 999 | sometimes |
| `n_flow_carry_on` | Times Carry on was used to continue a Flow session. | whole number, 0 to 999 | sometimes |
| `n_mode_to_flow` | Switches to Flow. | whole number, 0 to 999 | sometimes |
| `n_mode_to_chat` | Switches to Chat. | whole number, 0 to 999 | sometimes |
| `n_mode_to_dictate` | Switches to Dictate. | whole number, 0 to 999 | sometimes |
| `n_lobby_open` | Times the call setup screen was opened. | whole number, 0 to 999 | sometimes |
| `n_camera_on` | Times the camera was turned on in a call. | whole number, 0 to 999 | sometimes |
| `n_screen_on` | Times screen sharing was turned on in a call. | whole number, 0 to 999 | sometimes |
| `n_typed_msg` | Messages typed in a call. | whole number, 0 to 999 | sometimes |
| `n_ptt_toggle` | Times push to talk was switched on or off. | whole number, 0 to 999 | sometimes |
| `n_not_for_you` | Times a spoken turn was marked Not for you. | whole number, 0 to 999 | sometimes |
| `n_send_aside` | Sentences the side talk check set aside that you sent to the assistant anyway. | whole number, 0 to 999 | sometimes |
| `n_call_shortcut` | Times an in-call keyboard shortcut was used. | whole number, 0 to 999 | sometimes |
| `n_settings_tab_general` | Times the General page of Settings was shown. | whole number, 0 to 999 | sometimes |
| `n_settings_tab_models` | Times the Models page of Settings was shown. | whole number, 0 to 999 | sometimes |
| `n_settings_tab_voice` | Times the Voice page of Settings was shown. | whole number, 0 to 999 | sometimes |
| `n_settings_tab_engine` | Times the Speech engine page of Settings was shown. | whole number, 0 to 999 | sometimes |
| `n_settings_tab_agents` | Times the Agents page of Settings was shown. | whole number, 0 to 999 | sometimes |
| `n_settings_tab_capabilities` | Times the Capabilities page of Settings was shown. | whole number, 0 to 999 | sometimes |
| `n_settings_tab_tools` | Times the Tools part of the Capabilities page was shown. | whole number, 0 to 999 | sometimes |
| `n_settings_tab_connectors` | Times the Connectors part of the Capabilities page was shown. | whole number, 0 to 999 | sometimes |
| `n_settings_tab_skills` | Times the Skills part of the Capabilities page was shown. | whole number, 0 to 999 | sometimes |
| `n_settings_tab_memory` | Times the Memory page of Settings was shown. | whole number, 0 to 999 | sometimes |
| `n_settings_tab_chat` | Times the Chat page of Settings was shown. | whole number, 0 to 999 | sometimes |
| `n_settings_tab_flow` | Times the Flow page of Settings was shown. | whole number, 0 to 999 | sometimes |
| `n_settings_tab_dictate` | Times the Dictate page of Settings was shown. | whole number, 0 to 999 | sometimes |
| `n_settings_tab_privacy` | Times the Privacy page of Settings was shown. | whole number, 0 to 999 | sometimes |
| `n_settings_tab_about` | Times the About page of Settings was shown. | whole number, 0 to 999 | sometimes |

## Feedback event

What a feedback prompt reports. See [Feedback prompts](#feedback-prompts) for when one is asked.

### `feedback_given`

When a feedback prompt ends: answered, dismissed with its close button, hidden by itself after being ignored, or silenced with "Don't ask again". It is not sent when sharing is off.

Limit: at most 1 per day.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `surface` | What the prompt was about: a Flow session, a call, or the product as a whole (the 0 to 10 question, on the main window). | `flow`, `call`, `main` | always |
| `kind` | The session rating or the 0 to 10 question. | `session_rating`, `nps` | always |
| `outcome` | What happened to the prompt. `ignored` is a prompt that hid itself, or was still up when the window closed or a call began. | `answered`, `dismissed`, `ignored`, `never_again` | always |
| `rating` | Thumbs up or down, for an answered session rating. | `up`, `down` | sometimes |
| `score` | The answer to the 0 to 10 question, for an answered one. | whole number, 0 to 10 | sometimes |
| `reason` | What went wrong, one of five fixed choices, after a thumbs down. Never typed. | `wrong_answer`, `too_slow`, `misheard_me`, `didnt_do_it`, `other` | sometimes |
| `brain_kind` | For a session rating: `api` for a model provider, `acp` for a coding agent. | `api`, `acp` | sometimes |
| `brain_id` | For a session rating: which provider or coding agent. Never the model. | one of the [provider ids](#provider-ids) or [coding agent ids](#coding-agent-ids) | sometimes |
| `turns_bucket` | For a session rating: how many turns the session had, in four buckets. | `2`, `3_5`, `6_10`, `11_plus` | sometimes |

The pieces must fit. A rating or score comes only with `answered` (a rating for a session rating, a score for the 0 to 10 question), a reason only with a thumbs down, and the 0 to 10 question is only ever on `main`. An event that does not fit is dropped.

## Opt-out event

The one event sent when you turn sharing off.

### `telemetry_disabled`

When you turn sharing off, from the first-run notice or from Settings > Privacy. It is the last event an install sends. It is not sent when you opt out with an environment variable, or when the notice was never shown. Like every event it carries the `username` common property; unlike the first event of a launch, it never asks the server to file a named profile.

Limit: none.

| Property | Meaning | Values | Sent |
| --- | --- | --- | --- |
| `from` | Where you turned it off. | `notice`, `settings` | always |
| `days_since_first_open` | Whole days since the install first ran, capped at 999. | whole number, 0 to 999 | always |

## Reported settings

These are the settings `setting_changed` can report, with the values each one can take. A pair that is not listed here is dropped. Subject says whose id may ride along: a provider id, a coding agent id, or none.

| Setting | Meaning | Values | Subject |
| --- | --- | --- | --- |
| `login_item` | Open at login, on or off. | `on`, `off` | none |
| `end_on_lock` | End Flow and calls when the screen locks, on or off. On is the default. | `on`, `off` | none |
| `flow_armed` | Flow on or off, from the switch on Flow's home or the tray. | `on`, `off` | none |
| `theme` | The theme. | `system`, `light`, `dark` | none |
| `look` | The window look. | `glass`, `flat` | none |
| `custom_instructions` | Custom instructions saved or emptied. The text is never sent. | `set`, `cleared` | none |
| `narrate_progress` | Spoken progress narration, on or off. | `on`, `off` | none |
| `api_provider` | The provider for API mode changed. The value is always `none` and the provider is the subject. | `none` | provider id |
| `api_model` | The model for API mode changed or cleared. The model id is never sent. | `changed`, `cleared` | provider id |
| `vision_model` | The vision model changed or cleared. The id is never sent. | `changed`, `cleared` | provider id |
| `api_effort` | The reasoning effort for API mode. | `auto`, `low`, `medium`, `high`, `xhigh`, `max` | none |
| `ollama_address` | Where Ollama runs: the default, another address on this computer, or a remote one. The address is never sent. | `default`, `local`, `remote` | none |
| `agent_hidden` | A coding agent hidden from or shown in the lists. | `on`, `off` | agent id |
| `provider_key` | A provider key added or removed. The key is never sent. | `added`, `removed` | provider id |
| `agent_model` | The model for a coding agent changed. The model id is never sent. | `changed` | agent id |
| `language` | The session language. | one of the [languages](#languages) | none |
| `stt_family` | The speech-to-text engine family. | one of the [speech-to-text families](#speech-to-text-families) | none |
| `tts_family` | The text-to-speech engine family. `clone` is your own cloned voice. | one of the [text-to-speech families](#text-to-speech-families) | none |
| `wait_preset` | How long the assistant waits for you to finish a sentence. | `patient`, `even`, `quick`, `custom` | none |
| `voiceprint` | The voiceprint mode. | `off`, `label`, `gate` | none |
| `side_talk` | The side talk check mode. | `off`, `shadow`, `ignore` | none |
| `allow_restricted` | Whether models with a restricted license are allowed. | `on`, `off` | none |
| `default_brain` | Who answers by default: your API key or a coding agent. The subject is the coding agent, when it is one. | `api`, `acp` | agent id |
| `flow_own_brain` | Flow has its own choice of who answers, on or off. | `on`, `off` | none |
| `flow_brain` | Who answers in Flow: your API key or a coding agent. The subject is the coding agent, when it is one. | `api`, `acp` | agent id |
| `flow_speak_replies` | Flow speaks its replies, on or off. | `on`, `off` | none |
| `flow_own_wait` | Use a different pace for Flow, on or off. | `on`, `off` | none |
| `flow_quiet_meeting` | Stay quiet during meetings, on or off. | `on`, `off` | none |
| `flow_quiet_mic` | Stay quiet when another app uses the microphone, on or off. | `on`, `off` | none |
| `flow_quiet_dnd` | Stay quiet during Do Not Disturb, on or off. | `on`, `off` | none |
| `flow_consent` | Whether you have allowed Flow to act on the computer. | `on`, `off` | none |
| `flow_insertion` | How Flow puts text in: paste or type. | `paste`, `type` | none |
| `close_after_silence` | How long Flow and Dictate stay open with nothing said. | `30s`, `90s`, `5m`, `never`, `custom` | none |
| `voice_input_mode` | Push to talk works by holding the key or by toggling it. | `hold`, `toggle` | none |
| `ptt_enabled` | Push to talk, on or off. | `on`, `off` | none |

## Lists used above

The Values cells link here for the long lists.

### Provider ids

`anthropic`, `openai`, `minimax`, `ollama`, `ollama-cloud`, `groq`, `openrouter`, `deepseek`, `mistral`, `xai`, `google`, `together`, `fireworks`, `cerebras`, `perplexity`

### Coding agent ids

`claude-code`, `codex`, `cursor`, `opencode`, `hermes`, `gemini`, `copilot`, `kiro`, `pi`

### Languages

`en`, `es`, `fr`, `de`, `it`, `pt`, `hi`, `zh`, `ja`, `ko`

### Speech-to-text families

`whisper`, `nemotron`, `nemotron-3.5`, `parakeet`, `moonshine`, `canary`

### Text-to-speech families

`kokoro`, `supertonic`, `clone`, `pocket`, `kitten`, `piper`, `kokoro-native`, `matcha`

### Voice engine families

`nemotron`, `nemotron-3.5`, `parakeet`, `moonshine`, `canary`, `pocket`, `kitten`, `piper`, `kokoro-native`, `supertonic`, `matcha`, `voiceprint`, `addressee`

### Acceleration providers

`cpu`, `coreml`, `cuda`, `directml`, `webgpu`

### Failure codes

| Code | Meaning |
| --- | --- |
| `no_provider` | No model provider key or coding agent is set up. |
| `no_accessibility` | The OS has not given OpenLive Accessibility or input access, so Flow cannot type. |
| `secure_input` | A password field has the keyboard, so key presses are hidden. |
| `offline` | There is no network connection. |
| `models_missing` | The on-device voice models are not downloaded yet. |
| `hook_failed` | Flow's key listener stopped. |
| `addon_missing` | The native part of OpenLive that Flow needs did not load. |
| `mic_failed` | The microphone did not open, or was lost. |
| `answer_lost` | An answer never arrived, or the connection dropped while it was coming. |
| `brain_setup` | The brain refused the turn for a reason that is fixed in Settings, such as a missing key or model. |
| `turn_failed` | The brain failed the turn, and nothing in OpenLive fixes it. |

### Onboarding steps

| Step | Fires when |
| --- | --- |
| `flow_hook_started` | Flow's key listener started for the first time. |
| `flow_hook_failed` | Flow's key listener failed to start. |
| `first_flow_summon` | Flow's orb opened for the first time. |
| `first_call` | A call started for the first time. |
| `first_device_action` | Flow acted on the computer for the first time. |
| `first_agent_start_ok` | A coding agent started successfully for the first time, for a Flow session or a call. Opening History or Settings to look at an agent's sessions or models does not count. |
| `first_flow_reply` | A Flow turn ended in an answer for the first time. |
| `first_call_reply` | A call turn ended in an answer for the first time. |
| `activated` | The first turn in Flow or in a call that ended in an answer, whichever came first. |
| `flow_onboarding_shown` | Flow's first-run guide was shown. |
| `flow_onboarding_step2` | The guide moved on to its second step. |
| `flow_onboarding_done` | The guide was finished. |
| `flow_onboarding_skipped` | The guide was skipped. |
| `first_provider_key_saved` | A model provider key was saved for the first time. |
| `first_agent_install_ok` | A coding agent was installed from Settings for the first time. |
| `first_agent_ready` | A coding agent became ready to use for the first time. |
| `voice_models_ready` | The on-device voice models were ready for the first time. |
| `flow_consent_granted` | You allowed Flow to act on the computer for the first time. |
| `first_call_turn` | The first turn in a call. |
| `first_flow_turn` | The first turn in Flow. |
| `tour_closed_home` | The tour of the Home screen was closed. |
| `tour_closed_lobby` | The tour of the call setup screen was closed. |
| `tour_closed_call` | The tour of the call screen was closed. |
| `tour_closed_history` | The tour of History was closed. |
| `tour_closed_settings` | The tour of Settings was closed. |
| `first_settings_open` | Settings was opened for the first time. |
| `first_settings_search` | Settings search was used for the first time. |
| `first_palette_use` | The command palette was used for the first time. |
| `first_history_open` | History was opened for the first time. |
| `first_resume` | A conversation was resumed from History for the first time. |
| `first_flow_history_open` | A Flow session was opened from Flow's history for the first time. |
| `first_carry_on` | Carry on was used on a Flow session for the first time. |
| `first_lobby_open` | The call setup screen was opened for the first time. |
| `first_camera_on` | The camera was turned on in a call for the first time. |
| `first_screen_share` | Screen sharing was turned on in a call for the first time. |
| `first_typed_message` | A message was typed in a call for the first time. |
| `first_ptt_on` | Push to talk was switched on for the first time. |
| `first_mode_switch` | You switched between Chat, Flow and Dictate for the first time. |
| `first_shortcuts_sheet` | The keyboard shortcuts sheet was opened for the first time. |
