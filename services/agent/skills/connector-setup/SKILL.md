---
name: connector-setup
description: Use when the user wants to add, connect, sign in to or fix an MCP connector (a server that gives you tools for an app such as GitHub, Linear or Notion).
---

# Setting up connectors

A connector is an MCP server that gives every brain in OpenLive more tools.
Its tools show up as `<connector>__<tool>` once it is connected. You help the
user add one, sign in, and fix one that is not working.

Your tools: `list_connectors`, `add_connector`, `connector_sign_in`,
`reconnect_connector`.

## Secrets

- Never ask the user to say an API key or token out loud, and never repeat
  one back. Suggest they paste it in Settings, Capabilities, Connectors,
  where it is stored encrypted.
- If they paste one to you, pass it in `headers` (or inside `json`) and do not
  mention its value again. Tool results never show it.

## Adding one

1. Find out which server. Most services document either:
   - **A URL** (a remote server), as `https://mcp.example.com/mcp`. Call
     `add_connector` with `url` and a short `name`.
   - **A JSON block** in the `mcpServers` shape, with a `command` such as
     `npx` (a local server). Call `add_connector` with `json` set to that
     block, as text.
2. The user is asked to approve the add. Then read the result:
   - **connected**: done. Say how many tools it offers.
   - **needs sign-in**: go to "Signing in".
   - **waiting for the user to allow it to run**: a local server runs a
     program on their computer, so only the user can allow it: Settings,
     Capabilities, Connectors, then Review and Allow on that connector. You
     cannot allow it, and no tool can.
     Tell them where to click, then check with `list_connectors`.
   - **failed**: go to "Fixing one".

If they do not know the URL or JSON, offer to look it up (the research skill)
on the service's own documentation site.

## Signing in

For a connector that needs sign-in, call `connector_sign_in` with its id. It
opens the service's sign-in page in their browser, or gives you the address
to pass on. Ask them to finish signing in there, then call `list_connectors`
to confirm it is connected.

Only remote (URL) connectors sign in. A local one takes its keys as env values
in Settings, Capabilities, Connectors.

## Fixing one

Start with `list_connectors`. Then by status:

- **switched off**: they turned it off in Settings. Ask if they want it on;
  they switch it there.
- **waiting to be allowed**: as above, only they can allow it, in Settings.
- **needs sign-in**: `connector_sign_in`.
- **not connected yet**: normal. It connects when one of its tools is first
  used, or call `reconnect_connector`.
- **failed**: read the error, then `reconnect_connector` once. If it fails
  again, explain the likely cause in plain words:
  - "command not found" or ENOENT: the program (`npx`, `uvx`, `docker`) is
    not installed or not on the PATH.
  - 401 or 403: the key or sign-in is wrong or expired. Sign in again, or
    update the key in Settings.
  - 404 or a connection error: the URL is wrong or the server is down.
  - A crash right after starting: a missing env value the server needs.
- **connected but a tool is missing**: tools can be switched off one by one
  in Settings, Capabilities, Connectors. A server that changed its tools
  shows them after `reconnect_connector`.

Never retry the same thing more than twice. Tell the user what you found and
what they can do in Settings.
