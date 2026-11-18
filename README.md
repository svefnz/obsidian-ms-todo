# Microsoft To Do Sync for Obsidian

An Obsidian plugin that connects your vault to Microsoft To Do via the Microsoft Graph API.

## Features

- **Sign in with Microsoft** — OAuth 2.0 authorization code + PKCE flow, tokens auto-refreshed.
- **Import a To Do list as a note** — one note per list, tasks rendered as Markdown checkboxes (`- [ ]`) with due dates (📅) and notes (💭).
- **Map any note to a list** — sync an existing note with a To Do list.
- **Push new lines** — typing a new `- [ ]` task line in a mapped note creates the task in To Do.
- **Sync all mapped lists** — completion state, title changes, due dates, and note bodies propagate from To Do into the notes; new tasks are appended.
- **Auto-sync** on a configurable interval (settings).

## Setup

1. Register an app in [Azure Portal → App registrations](https://portal.azure.com/#blade/Microsoft_Azure_RegisteredApps/ApplicationsListBlade):
   - Supported account types: personal Microsoft accounts **and/or** work/school.
   - No client secret needed (public client).
   - Add a **Mobile and desktop applications** platform with redirect URI `https://localhost/ms-todo-auth`.
   - Grant delegated permissions: `Tasks.ReadWrite`, `offline_access`, `User.Read`.
2. Copy the **Application (client) ID** into the plugin settings.
3. Run command **"Sign in to Microsoft To Do"** and complete the browser flow.
4. Run **"Import a To Do list as a note"** or **"Map current note to a To Do list"**.

## Commands

| Command | Action |
|---|---|
| Sign in to Microsoft To Do | OAuth sign-in |
| Sync all mapped lists | Pull To Do → mapped notes, push new note lines → To Do |
| Import a To Do list as a note | Create a note from a list and map it |
| Map current note to a To Do list | Attach the active note to a list |

## How sync matching works

- Lines ending with a block id `^ms-todo-<taskid>` are matched to that exact task.
- Unmatched note lines are matched by title; tasks absent from the note are appended.
- Checking/unchecking a box in the note and running **Sync** pushes the state to To Do.

## Development

```sh
npm install
npm run build        # production bundle -> main.js
npm run test         # logic self-checks
```

Copy `main.js`, `manifest.json` to `.obsidian/plugins/ms-todo-sync/` in a test vault to try it.
