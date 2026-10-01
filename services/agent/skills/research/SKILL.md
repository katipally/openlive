---
name: research
description: Use when the user asks you to research, compare, fact-check or find current information, and the answer should come with sources.
---

# Researching well

Good research answers the question asked, from sources that can be checked,
and says plainly what is still uncertain.

## Your tools

- **`delegate(task)`**: hands one task to OpenLive's research assistant, who
  has `web_search` and `fetch_url` and reports back a short summary. It works
  while you keep talking and takes a few search steps at most, so give it one
  focused question per call.
- **`web_search` and `fetch_url`**: if these are in your own tool list, call
  them directly instead of delegating. A coding agent may also have its own
  web tools; use whichever you have.

If you have none of these, say you cannot look it up right now and answer only
from what you are sure of, marked as such.

## 1. Plan the questions

Before searching, break the request into the few facts that decide the answer.
"Which laptop should I buy" becomes: the models in their budget, battery life
measured by reviewers, current prices. Two to four focused questions beat one
vague one.

Tell the user in one short line what you are checking, then start.

## 2. Ask for sources, every time

The assistant returns plain sentences and leaves links out unless asked. So
write each delegated task to ask for them:

> Find the current price of the Framework Laptop 13 in the US, from the
> official store, with the source URL.

Good task lines name: the exact fact, the time frame ("as of this month"), the
kind of source you want (official site, the paper, the filing, a named outlet),
and "with source URLs".

With `web_search` yourself: search, pick the most authoritative results, then
`fetch_url` them to read the page itself. Search highlights are a lead, not a
source.

## 3. Prefer primary sources

In order:

1. The original: the official page, the paper, the dataset, the changelog,
   the court filing, the company's own announcement.
2. A reputable outlet reporting on it, with a date.
3. Everything else, only to find 1 or 2.

Check the date. For anything that changes (prices, versions, schedules,
office holders, scores), an old page is a wrong answer.

## 4. Cross-check

- A fact that decides the answer needs two independent sources, or one
  primary source.
- When sources disagree, say so, give both, and say which you trust and why.
- A number with no source stays out of the answer.

If a step comes back empty or vague, rephrase once (other words, a narrower
question, the official site's name). Do not repeat the same task.

## 5. Answer and cite

- Lead with the answer in a sentence or two. Then the supporting facts.
- Cite inline, right after the claim, with the URL: "The base model is $999
  (https://frame.work/...)". In a spoken reply, name the source out loud ("per
  the official store") and keep the URLs for the written reply.
- Keep it short. The user asked a question, not for a report, unless they
  asked for a report.

## 6. Say what is uncertain

End with what you could not confirm, if anything: "I could not find a 2026
figure; the latest is from March 2025." Never fill a gap with a guess dressed
as a fact. "I don't know yet" is a fine answer, and better than a confident
wrong one.
