# OpenLive privacy policy

Last updated: 2026-10-03.

This page covers the anonymous usage data the OpenLive desktop app can send to the project. It is written to be read, not skimmed past. The exact list of every event and field is in [docs/TELEMETRY.md](TELEMETRY.md), and the two pages are kept in step.

```
 your machine                                   the project
 ------------------------------------           ------------------------------------
 what you say, type, show, open          X      never leaves
 fixed labels, counts, rounded timings   --->   self-hosted analytics, one server
 random install ID + readable name       --->   (no third-party analytics company)
 location                                X      never stored
```

## The short version

- OpenLive shares anonymous usage: which features get used, what fails and how fast things run.
- It never shares what you say or type, your files, names, window titles, keys, model ids or error text.
- It is on by default, with a notice the first time you see the app. Nothing is sent before you have seen that notice.
- You can turn it off in one click. After that, nothing is sent at all, apart from one last event saying you turned it off.
- Nothing is sold, nothing is used for ads, and no outside analytics company receives it.

## What is collected

- **Feature use.** Which screens and features were used, as counts, and how a session went: how long, how many turns, whether a tool was used, how it ended.
- **Errors and speed.** The kind of failure (as a fixed label, never the message), crashes counted as crashes, and rounded timings such as how long a reply took to start.
- **Setup and first use.** Which first-run steps were reached, which settings were changed to which fixed value, and whether a download or install worked.
- **Your setup, in broad strokes.** The app version, your OS family and major version, your CPU type, and which provider or coding agent you picked as a fixed id. Never the model, never a key.
- **An install ID and a name.** A random ID made on your computer, and a readable name derived from it, like `swift-otter-1a2b3c4d`. They are there so the project can count active installs and see whether people come back. They are not derived from your hardware, account, name or network, and turning sharing off deletes them.
- **Answers to feedback prompts.** A thumbs up or down, one of five fixed reasons, or a 0 to 10 score, when you choose to answer. See [Feedback prompts](#feedback-prompts).
- **A timestamp** on each event, rounded down to the minute.

Every field is a label from a fixed list, true or false, a capped number or an app version. There is no free text field anywhere, so a sentence you said or typed cannot end up in an event. The app checks each event against the list before it stores it and drops anything that does not match.

## What is never collected

- What you say, the audio, the transcript, anything you type or ask.
- Files, folders, paths, clipboard, screenshots, camera or screen frames.
- Window titles, app names Flow works in, names, email addresses, API keys.
- Model ids, error messages, stack traces, logs.
- Your location. See [Location](#location).
- Anything that would identify you as a person, such as an account, because OpenLive has no account.

## The microphone and your selection

These stay on your computer whatever the sharing setting, and are here so you know when OpenLive reads them.

- **The microphone** is open only while Flow, Dictate or a call is. In Push to talk (Settings > General > How you talk) it is open only while you hold the key or the Hold to talk button, and every track is stopped when you let go, so the system's microphone indicator is off between holds. Hands-free, it stays open while the session does.
- **Selected text**, for editing it by voice, is read through the system's accessibility API only. OpenLive never copies a selection to read it, so your clipboard is not touched for it. Where an app does not share its selection that way, your words are typed instead.

## Why

To improve the product: to see which features are used and which are not, what breaks, what is slow and where new people give up. That is all it is used for.

## Legal basis

Where the law asks for one (the EU and UK GDPR, for example), the basis is legitimate interest: the project has a real interest in knowing whether its software works, the data is small and anonymous in design, and opting out is one click and is honored completely.

Under the EU view, a random install ID is a pseudonymous identifier, which still counts as personal data. So OpenLive treats it that way and gives you the rights that come with it: to see what is held, to have it deleted, and to object. See [Your rights](#your-rights) and [Contact](#contact).

## Where it is stored

Events go over HTTPS to a self-hosted [OpenPanel](https://openpanel.dev) instance, run by the maintainer on the maintainer's own server. The server is reached through Cloudflare, which carries the traffic to it. There is no third-party analytics company in the path, nothing is sold, nothing is used for advertising, and no data is handed to advertisers or brokers.

Like any internet request, yours travels through the networks between you and the server, and Cloudflare, as a carrier, can see ordinary request data such as your IP address while the request passes. The analytics records do not keep it, although the server does receive ordinary request headers, such as a user agent. See [Location](#location).

## Location

OpenLive does not ask for your location and the project does not store one. Each event carries a placeholder address (`127.0.0.1`) in place of your IP address, so the analytics server records no country, city, region or coordinates for you.

## How long it is kept

Analytics events are kept for **24 months**, counted from the time stamped on the event. A job on the server runs monthly and deletes everything older, including the usage profile of an install once it has no events left. There is no archive and nothing is moved anywhere else.

The server also keeps backups, a nightly copy on the same machine (the newest 14) and a weekly encrypted copy off the machine (the newest 8 weeks). They exist to restore the server after a failure, nobody reads them for analysis, and they are not edited when something is deleted. Deleted events therefore roll out of the backups too, within about 8 weeks.

## Your choices

- **The first-run notice.** The first time the app shows its window, it says what it shares and offers **Turn off**. Nothing is sent until that notice has been on screen.
- **Settings > Privacy > Share anonymous usage.** Off at any time, on again at any time.
- **Before the app starts.** Set `OPENLIVE_TELEMETRY=0` or `DO_NOT_TRACK=1` in the environment the app starts in.
- **Builds from source.** A build you compile yourself, a development build and any build without the release settings send nothing.
- **Feedback prompts.** Every prompt has a "Don't ask again" button, honored for good, and Settings > Privacy > Ask for feedback changes it.
- **Access and deletion.** Settings > Privacy shows your anonymous name, can copy it, and **Request deletion** opens a draft email to the contact below with that name filled in. Nothing is sent until you send the email yourself. A request needs that name, and turning sharing off deletes it from your computer, so if you want events already sent to be deleted, copy the name first (Settings > Privacy > Copy) or send the request before you turn sharing off. See [Your rights](#your-rights).

## What happens when you opt out

What is sent depends on how you opt out:

- **An environment variable** (`OPENLIVE_TELEMETRY=0` or `DO_NOT_TRACK=1`): nothing at all, not even a last event.
- **Turn off on the first-run notice:** anything still waiting is thrown away, then one last event named `telemetry_disabled` is sent, saying it came from the notice and how many days the install has existed. It carries your anonymous name as a property, like every event, so a deletion request can still find it, but it does not ask the server to create a named profile. Then nothing more is sent.
- **Settings > Privacy > Share anonymous usage:** the same, with `settings` as the place. The profile the server already holds for the install keeps the name it already had.

After that the install ID is deleted from your computer, and so is the anonymous name, which is made from it. Turning sharing back on makes a new ID and a new name. The notice and the Settings row both say this. If the app cannot save your choice, it keeps it in a second small file on your computer, and sharing stays off until you turn it on again.

Opting out does not delete events already sent. Ask for that with the contact below, and copy your anonymous name first: the app deletes it when you turn sharing off, and it is the only way to find your events.

## Your rights

Under laws such as the EU and UK GDPR and the California CCPA you may ask to see the data held about you, to have it deleted, and to object to it being collected. Here is how each works for OpenLive:

- **Object, or stop it.** Turn sharing off, as above. It takes effect at once and nothing more is sent. This is your objection, and it is honored completely.
- **Access.** Ask the contact below and you get a copy of the events held under your anonymous name.
- **Deletion.** Ask the contact below and every event and the profile under that name are deleted from the analytics server.
- **No account, so no other data.** OpenLive holds no name, email address, location or account for you. The only things tied to you are the events sent under your random install ID and anonymous name.

The data is pseudonymous: nothing in it says who you are, so the project cannot work out which events are yours. It can only find them if you send your anonymous name (Settings > Privacy > Your anonymous name). Without it there is no way to tell your events from anyone else's, and the project will not ask you for more identifying information to find them.

Nothing here is sold or shared, so there is nothing to opt out of selling. If you are unhappy with how a request was handled, you may also complain to your local data protection authority.

## Feedback prompts

Now and then the app shows a small card in the main window asking how a session went, or how likely you are to recommend OpenLive to a friend. It is rare (at most one prompt a week, the 0 to 10 question at most once a quarter, never in your first two days), never appears during a session, takes one tap, has no text box and goes away by itself. Answers are the fixed choices above and nothing you type. Nothing is asked while sharing is off. The details and exact limits are in [docs/TELEMETRY.md](TELEMETRY.md#feedback-prompts).

## Crash and bug detail

OpenLive has no crash reporter and never uploads logs. The crash events only count that a crash happened. If you want to give detail, Settings > Privacy > Report a problem opens a GitHub issue that you write and submit yourself. It is prefilled with only your OpenLive version, your OS name and version, the provider id and the last Flow failure code. Nothing is sent until you submit it, and GitHub's own privacy policy then applies to the issue.

## What this policy does not cover

The words you say and the frames you share go to the model provider or coding agent you chose, under their terms, and nowhere else. Choose a local model and they stay on your machine. The project does not see them and this page does not govern them.

Dictate's history (listed on Dictate's home) keeps what you dictated in a file on your machine, for as long as Settings > Dictate > Basics > History says, and never sends it anywhere. Delete one dictation on the home, all of them with Clear all in Settings, or set it to keep nothing. Plain dictation goes to no model at all; AI polish and command mode send the words, and the selected text, to your API key's provider or the coding agent that answers for Dictate.

Everything else OpenLive keeps on your machine (chats, memory, settings, saved keys, and what the app remembers between launches, like the mode and chat you left open) is in one folder, `~/.openlive` (`%USERPROFILE%\.openlive` on Windows), shown in Settings > About. Reset local data there erases all of it, along with the app's browser storage, and starts again fresh. If you turned usage data off, it stays off after a reset, and Open at login keeps your setting.

## Children

OpenLive is not directed at children under 13, or under 16 where local law sets that age, and does not knowingly collect personal data from them. The analytics cannot tell a child from an adult and holds no name, age or account. If you believe a child's install has been counted, use the contact below and the events under its anonymous name will be deleted.

## Changes to this policy

The policy lives in the repository as `docs/PRIVACY.md`, so every change is a public, dated edit in its history. The date at the top moves when it changes. A change that collects something new is listed in [docs/TELEMETRY.md](TELEMETRY.md) and the release notes before the build that sends it ships.

## Contact

The responsible party is Yashwanth Reddy Katipally, maintainer of OpenLive.

Email [privacy@openlive.dev](mailto:privacy@openlive.dev) for any privacy question or request.

To ask for deletion or a copy of your data:

1. Open Settings > Privacy in the app. **Request deletion** opens an email with your anonymous name filled in. Or copy the name and write the email yourself.
2. Send it. The name is the only thing needed. Do not send anything else about yourself.
3. The events under that name are deleted from the analytics server within 30 days, and the copies in backups roll off within about 8 weeks after that. A reply confirms it when it is done. For a copy of your data, the reply carries it.

If you turned sharing off and on again, earlier events sit under the old name. Send the old name too, if you still have it.
