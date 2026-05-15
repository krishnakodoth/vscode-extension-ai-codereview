# AI Code Review

AI-powered code review directly in VS Code. Sends your git changes to an n8n webhook and displays a structured review in the sidebar.

## Features

- **Full Git Diff** — reviews all current unstaged changes
- **File Wise** — select specific modified files from a checklist
- **Commit Wise** — review any commit by SHA (optionally from another repo path)
- Results rendered with rich formatting in the sidebar
- **Open in New Tab** — view the full review as a Markdown document

## Setup

1. Install the extension
2. Click the **AI Review** icon in the Activity Bar
3. Click **Configure** and enter your n8n webhook URL
4. The green dot confirms the webhook is ready

## Usage

Select a review mode, fill in any required fields, and click **Start Review**.

## Configuration

| Setting | Description |
|---|---|
| `ai-review-extension.webhookUrl` | Your n8n webhook URL (stored globally) |


## Following extension guidelines

Ensure that you've read through the extensions guidelines and follow the best practices for creating your extension.

* [Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)

## Working with Markdown

You can author your README using Visual Studio Code. Here are some useful editor keyboard shortcuts:

* Split the editor (`Cmd+\` on macOS or `Ctrl+\` on Windows and Linux).
* Toggle preview (`Shift+Cmd+V` on macOS or `Shift+Ctrl+V` on Windows and Linux).
* Press `Ctrl+Space` (Windows, Linux, macOS) to see a list of Markdown snippets.

## For more information

* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

**Enjoy!**
