import * as vscode from "vscode";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Strip ANSI escape codes from git output (ESC + [ + digits/semicolons + m)
const ANSI_STRIP_RE = new RegExp(String.fromCodePoint(27) + String.raw`\[[0-9;]*m`, "g");

interface WebviewMessage {
  command: string;
  reviewType?: string;
  selectedFiles?: string[];
  commitId?: string;
  repoPath?: string;
  flatFilePaths?: string[];
  filePath?: string;
  line?: number;
  content?: string;
  htmlContent?: string;
  reviewFiles?: string[];
}

interface FileDiff {
  file: string;
  gitDiff: string;
  fullFile?: string;
}

type ReviewResult =
  | { status: "ok"; files: FileDiff[] }
  | { status: "error"; message: string }
  | { status: "cancelled" };

export class AiReviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "aiReviewSidebar";

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.options = { enableScripts: true };

    const initiallyConfigured = !!vscode.workspace
      .getConfiguration("ai-review-extension")
      .get<string>("webhookUrl", "");
    webviewView.webview.html = this.getHtml(initiallyConfigured);

    webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      if (message.command === "ready") {
        // No-op: initial state is already baked into the HTML.
      } else if (message.command === "configureWebhook") {
        await this.configureWebhookUrl(webviewView);
      } else if (message.command === "requestChangedFiles") {
        this.sendChangedFiles(webviewView);
      } else if (message.command === "startReview") {
        await this.handleStartReview(webviewView, message);
      } else if (message.command === "openInNewWindow") {
        const doc = await vscode.workspace.openTextDocument({
          content: message.content ?? "",
          language: "markdown",
        });
        await vscode.window.showTextDocument(doc, {
          preview: false,
          viewColumn: vscode.ViewColumn.Beside,
        });
      } else if (message.command === "openFile") {
        await this.openFileAtLine(message.filePath ?? "", message.line ?? 1);
      } else if (message.command === "downloadPdf") {
        await this.handleDownloadPdf(message.htmlContent ?? "", message.reviewFiles ?? []);
      }
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private postWebhookStatus(webviewView: vscode.WebviewView) {
    const url = vscode.workspace
      .getConfiguration("ai-review-extension")
      .get<string>("webhookUrl", "");
    webviewView.webview.postMessage({ type: "webhookStatus", configured: !!url });
  }

  private getWorkspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? process.cwd();
  }

  private sendChangedFiles(webviewView: vscode.WebviewView) {
    const repoDir = this.getWorkspaceRoot();
    const result = spawnSync("git", ["diff", "--name-only"], { encoding: "utf-8", cwd: repoDir });
    const files: string[] = (result.stdout || "")
      .split("\n").map((f: string) => f.trim()).filter(Boolean);
    webviewView.webview.postMessage({ type: "changedFiles", files });
  }

  private splitDiffByFile(diff: string): FileDiff[] {
    // Collect raw line groups per file, then build FileDiff objects
    const groups: { file: string; lines: string[] }[] = [];

    for (const line of diff.split("\n")) {
      if (line.startsWith("diff --git")) {
        groups.push({ file: line.split(" b/")[1], lines: [line] });
      } else if (groups.length > 0) {
        groups.at(-1)!.lines.push(line);
      }
    }

    return groups.map(({ file, lines }) => ({ file, gitDiff: lines.join("\n") }));
  }

  private async handleDownloadPdf(htmlContent: string, reviewFiles: string[]) {
    const filesSection = reviewFiles.length
      ? "<div style=\"margin:0 0 14px\"><p style=\"font-size:10pt;color:#555;margin:0 0 4px;font-weight:600\">Files reviewed:</p>" +
        "<ul style=\"margin:0;padding:0 0 0 18px;list-style-type:disc\">" +
        reviewFiles.map(f => "<li style=\"font-size:9pt;color:#555;font-family:monospace;line-height:1.6\">" + f + "</li>").join("") +
        "</ul></div>"
      : "";
    const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>AI Code Review</title>
<style>
  body { font-family: sans-serif; font-size: 11pt; color: #000; background: #fff; max-width: 900px; margin: 40px auto; padding: 0 24px; }
  h1 { font-size: 14pt; font-weight: bold; margin: 12px 0 6px; }
  h2 { font-size: 11pt; font-weight: bold; margin: 10px 0 4px; border-bottom: 1px solid #ccc; padding-bottom: 2px; }
  .rv-file { font-family: monospace; font-size: 9pt; background: #f0f0f0; padding: 1px 5px; border-radius: 2px; display: inline-block; margin-bottom: 4px; }
  .rv-score { font-weight: bold; font-size: 10pt; margin: 6px 0; }
  ul { margin: 3px 0 3px 18px; padding: 0; }
  li { margin-bottom: 4px; font-size: 10pt; line-height: 1.5; }
  p { font-size: 10pt; margin: 2px 0; line-height: 1.5; }
  hr { border: none; border-top: 1px solid #ccc; margin: 10px 0; }
  code { font-family: monospace; background: #f0f0f0; padding: 0 3px; border-radius: 2px; font-size: 9pt; }
  a { color: #000; text-decoration: none; }
  @media print { body { margin: 20px; } }
</style>
</head>
<body>
<h1 style="font-size:16pt;border-bottom:2px solid #333;padding-bottom:6px;margin-bottom:14px">AI Code Review</h1>
${filesSection}
${htmlContent}
</body>
</html>`;
    const tmpFile = path.join(os.tmpdir(), `ai-review-${Date.now()}.html`);
    try {
      fs.writeFileSync(tmpFile, fullHtml, "utf-8");
      await vscode.env.openExternal(vscode.Uri.file(tmpFile));
    } catch {
      vscode.window.showErrorMessage("Failed to open review for PDF export.");
    }
  }

  private async openFileAtLine(filePath: string, line: number) {
    const repoDir = this.getWorkspaceRoot();
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(repoDir, filePath);
    try {
      const uri = vscode.Uri.file(absolutePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    } catch {
      vscode.window.showErrorMessage(`Could not open file: ${filePath}`);
    }
  }

  private readFullFile(filePath: string): string {
    try {
      const absolutePath = path.resolve(filePath);
      if (!fs.existsSync(absolutePath)) { return ""; }
      return fs.readFileSync(absolutePath, "utf-8");
    } catch {
      return "";
    }
  }

  private readFileAtCommit(commitId: string, filePath: string, repoDir: string): string {
    try {
      const result = spawnSync("git", ["show", `${commitId}:${filePath}`], {
        encoding: "utf-8",
        cwd: repoDir,
      });
      if (result.status !== 0) { return ""; }
      return result.stdout;
    } catch {
      return "";
    }
  }

  private async postToWebhook(webhookUrl: string, payload: object): Promise<string> {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object") {
        const p = parsed as Record<string, unknown>;
        if (typeof p["review"] === "string") { return p["review"]; }
        if (typeof p["body"] === "string") { return p["body"]; }
      }
      return JSON.stringify(parsed, null, 2);
    } catch {
      return text;
    }
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  private async configureWebhookUrl(webviewView: vscode.WebviewView) {
    const current = vscode.workspace
      .getConfiguration("ai-review-extension")
      .get<string>("webhookUrl", "");

    const value = await vscode.window.showInputBox({
      title: "Configure AI Review Webhook URL",
      prompt: "Enter your n8n webhook URL",
      value: current,
      placeHolder: "https://your-n8n-instance/webhook/...",
      ignoreFocusOut: true,
    });

    if (value !== undefined) {
      await vscode.workspace
        .getConfiguration("ai-review-extension")
        .update("webhookUrl", value, vscode.ConfigurationTarget.Global);
      webviewView.webview.postMessage({ type: "webhookStatus", configured: !!value });
    }
  }

  private collectFullDiff(repoDir: string): ReviewResult {
    const result = spawnSync("git", ["diff"], { encoding: "utf-8", cwd: repoDir });
    if (result.status !== 0) {
      const errMsg = result.stderr?.replaceAll(ANSI_STRIP_RE, "").trim().slice(0, 300) || "git diff failed";
      return { status: "error", message: errMsg };
    }
    if (!result.stdout.trim()) {
      return { status: "error", message: "No unstaged changes found." };
    }
    const files = this.splitDiffByFile(result.stdout);
    files.forEach((f) => { f.fullFile = this.readFullFile(path.join(repoDir, f.file)); });
    return { status: "ok", files };
  }

  private async collectCommitDiff(commitId: string, repoPath: string): Promise<ReviewResult> {
    const repoDir = repoPath.trim() || this.getWorkspaceRoot();

    if (!fs.existsSync(repoDir)) {
      return { status: "error", message: `Repository path not found: ${repoDir}` };
    }

    const runShow = () => spawnSync(
      "git", ["show", "--no-color", commitId],
      { encoding: "utf-8", cwd: repoDir, shell: true },
    );

    let result = runShow();

    if (result.error) {
      return { status: "error", message: `Failed to run git: ${result.error.message}\n(ran in: ${repoDir})` };
    }

    // Commit might only exist on a remote (e.g. merged to DEV but not yet fetched locally).
    // Attempt a full fetch and retry before giving up.
    if (result.status !== 0) {
      spawnSync("git", ["fetch", "--all", "--quiet"], {
        encoding: "utf-8",
        cwd: repoDir,
        shell: true,
        timeout: 30000,
      });
      result = runShow();
    }

    if (result.error) {
      return { status: "error", message: `Failed to run git: ${result.error.message}\n(ran in: ${repoDir})` };
    }
    if (result.status !== 0) {
      const stderr = result.stderr?.replaceAll(ANSI_STRIP_RE, "").trim().slice(0, 500) ?? "";
      const stdout = result.stdout?.trim().slice(0, 500) ?? "";
      const detail = stderr || stdout;
      const exitCode = result.status ?? "null";
      const errMsg = detail
        ? `git show failed (exit ${exitCode}):\n${detail}`
        : `git show failed (exit ${exitCode}).\nThe commit was not found locally or on any configured remote.\nMake sure the repository path is correct and the commit exists.`;
      return { status: "error", message: `${errMsg}\n\nRepository: ${repoDir}` };
    }
    if (!result.stdout.trim()) {
      return { status: "error", message: "No changes found for this commit." };
    }
    const files = this.splitDiffByFile(result.stdout);
    files.forEach((f) => { f.fullFile = this.readFileAtCommit(commitId, f.file, repoDir); });
    return { status: "ok", files };
  }

  private collectFileDiff(selectedFiles: string[], repoDir: string): ReviewResult {
    if (selectedFiles.length === 0) {
      return { status: "error", message: "No files selected for review." };
    }

    let combinedDiff = "";
    for (const file of selectedFiles) {
      const r = spawnSync("git", ["diff", "--", file], { encoding: "utf-8", cwd: repoDir });
      if (r.status === 0) { combinedDiff += r.stdout; }
    }

    if (!combinedDiff.trim()) {
      return { status: "error", message: "No diff found for selected files." };
    }
    const files = this.splitDiffByFile(combinedDiff);
    files.forEach((f) => { f.fullFile = this.readFullFile(path.join(repoDir, f.file)); });
    return { status: "ok", files };
  }

  private collectFlatFileDiff(filePaths: string[]): ReviewResult {
    if (filePaths.length === 0) {
      return { status: "error", message: "No file paths provided for flat file review." };
    }

    const workspaceRoot = this.getWorkspaceRoot();
    const files: FileDiff[] = [];
    const notFound: string[] = [];

    for (const filePath of filePaths) {
      const trimmed = filePath.trim();
      if (!trimmed) { continue; }

      const absolutePath = path.isAbsolute(trimmed)
        ? trimmed
        : path.resolve(workspaceRoot, trimmed);

      if (!fs.existsSync(absolutePath)) {
        notFound.push(trimmed);
        continue;
      }

      let content: string;
      try {
        content = fs.readFileSync(absolutePath, "utf-8");
      } catch {
        notFound.push(trimmed);
        continue;
      }

      const relPath = path.relative(workspaceRoot, absolutePath).replaceAll("\\", "/");
      const lines = content.split("\n");
      if (lines.at(-1) === "") { lines.pop(); }
      const lineCount = lines.length;

      const gitDiff = [
        `diff --git a/${relPath} b/${relPath}`,
        `--- a/${relPath}`,
        `+++ b/${relPath}`,
        `@@ -0,0 +1,${lineCount} @@`,
        ...lines.map(l => `+${l}`),
      ].join("\n");

      files.push({ file: relPath, gitDiff, fullFile: content });
    }

    if (files.length === 0) {
      const msg = notFound.length > 0
        ? `File(s) not found or unreadable:\n${notFound.map(f => `\u2022 ${f}`).join("\n")}`
        : "No valid file paths provided.";
      return { status: "error", message: msg };
    }

    return { status: "ok", files };
  }

  private async handleStartReview(webviewView: vscode.WebviewView, message: WebviewMessage) {
    const webhookUrl = vscode.workspace
      .getConfiguration("ai-review-extension")
      .get<string>("webhookUrl", "");

    if (!webhookUrl) {
      webviewView.webview.postMessage({
        type: "reviewError",
        message: "Webhook URL not configured. Click 'Configure' first.",
      });
      return;
    }

    const repoDir = this.getWorkspaceRoot();
    webviewView.webview.postMessage({ type: "reviewStart" });

    try {
      let result: ReviewResult;
      if (message.reviewType === "commit") {
        const commitId = message.commitId ?? "";
        if (!/^[0-9a-f]{7,64}$/i.test(commitId)) {
          webviewView.webview.postMessage({ type: "reviewError", message: "Invalid commit SHA. Must be 7–64 hex characters." });
          return;
        }
        result = await this.collectCommitDiff(commitId, message.repoPath ?? "");
      } else if (message.reviewType === "file") {
        result = this.collectFileDiff(message.selectedFiles ?? [], repoDir);
      } else if (message.reviewType === "flatfile") {
        const fps = message.flatFilePaths ?? [];
        if (fps.length === 0) {
          webviewView.webview.postMessage({ type: "reviewError", message: "No file paths provided for flat file review." });
          return;
        }
        result = this.collectFlatFileDiff(fps);
      } else {
        result = this.collectFullDiff(repoDir);
      }

      if (result.status === "cancelled") {
        webviewView.webview.postMessage({ type: "reviewCancelled" });
        return;
      }
      if (result.status === "error") {
        webviewView.webview.postMessage({ type: "reviewError", message: result.message });
        return;
      }

      const reviewText = await this.postToWebhook(webhookUrl, { files: result.files });
      webviewView.webview.postMessage({
        type: "reviewResult",
        review: reviewText,
        files: result.files.map((f) => f.file),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      webviewView.webview.postMessage({ type: "reviewError", message: msg });
    }
  }

  // ── Webview HTML ──────────────────────────────────────────────────────────

  private getHtml(webhookConfigured: boolean): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';"/>
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 12px;
    margin: 0;
    box-sizing: border-box;
  }
  h2 { margin: 0 0 12px; font-size: 1.05em; font-weight: 600; }
  .webhook-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    background: var(--vscode-editor-inactiveSelectionBackground);
    border-radius: 4px;
    margin-bottom: 14px;
  }
  .dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--vscode-errorForeground);
  }
  .dot.ok { background: #4caf50; }
  .webhook-label { flex: 1; font-size: 0.82em; }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 5px 10px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.82em;
    white-space: nowrap;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.45; cursor: default; }
  #mainPanel { transition: opacity 0.15s; }
  #mainPanel.locked { opacity: 0.38; pointer-events: none; user-select: none; }
  .unconfigured-hint {
    font-size: 0.82em;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 10px;
    display: none;
  }
  .unconfigured-hint.visible { display: block; }
  .radio-group label {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 7px;
    cursor: pointer;
    font-size: 0.9em;
  }
  /* ── Extra inputs shown per review type ── */
  .extra { margin-top: 10px; display: none; }
  .extra.visible { display: block; }
  .extra label { font-size: 0.82em; color: var(--vscode-descriptionForeground); display: block; margin-bottom: 3px; }
  .extra input[type=text], .extra textarea {
    width: 100%;
    box-sizing: border-box;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #555);
    border-radius: 3px;
    padding: 4px 7px;
    font-size: 0.85em;
    margin-bottom: 8px;
    font-family: var(--vscode-editor-font-family, monospace);
    resize: vertical;
  }
  .extra input[type=text]:focus, .extra textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  /* ── File checklist ── */
  #fileList { margin-top: 6px; max-height: 160px; overflow-y: auto; }
  .file-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 2px;
    border-radius: 3px;
    font-size: 0.84em;
  }
  .file-item:hover { background: var(--vscode-list-hoverBackground); }
  .file-item input { cursor: pointer; }
  .file-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .select-bar {
    display: flex;
    gap: 10px;
    margin-bottom: 4px;
    font-size: 0.78em;
  }
  .select-bar a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  .select-bar a:hover { text-decoration: underline; }
  /* ── Review button ── */
  #reviewBtn { width: 100%; padding: 7px; margin-top: 10px; font-size: 0.9em; }
  #output { margin-top: 14px; }
  .msg { padding: 8px 10px; border-radius: 4px; font-size: 0.85em; }
  .msg.info { background: var(--vscode-editor-inactiveSelectionBackground); }
  .msg.error {
    background: var(--vscode-inputValidation-errorBackground, rgba(90,30,30,0.6));
    color: var(--vscode-errorForeground);
    border: 1px solid var(--vscode-inputValidation-errorBorder, transparent);
  }
  /* ── Review result ── */
  .review-result-wrap { max-height: 60vh; overflow-y: auto; border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 10px 12px; background: var(--vscode-editor-background); }
  .review-toolbar { margin-bottom: 8px; }
  .review-files-box { max-height: 80px; overflow-y: auto; border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 4px 8px; margin-bottom: 6px; background: var(--vscode-editor-inactiveSelectionBackground); }
  .review-files-box ul { margin: 0; padding: 0 0 0 14px; list-style-type: disc; }
  .review-files-box li { font-size: 0.78em; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace); line-height: 1.6; word-break: break-all; list-style-type: disc; }
  .toolbar-btns { display: flex; gap: 6px; }
  .open-btn { flex: 1; font-size: 0.8em; padding: 5px 4px; text-align: center; background: var(--vscode-button-secondaryBackground, #3c3c4a); color: var(--vscode-button-secondaryForeground, #cdd6f4); border-radius: 3px; }
  .open-btn:hover { background: var(--vscode-button-secondaryHoverBackground, #505060); }
  .file-link { color: inherit; text-decoration: none; cursor: pointer; }
  .file-link:hover { text-decoration: underline; }
  .line-link { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
  .line-link:hover { text-decoration: underline; }
  .rv-section { margin-bottom: 10px; }
  .rv-h1 { font-size: 1em; font-weight: 700; margin: 0 0 6px; color: var(--vscode-foreground); }
  .rv-h2 { font-size: 0.87em; font-weight: 600; margin: 10px 0 4px; padding-bottom: 2px; border-bottom: 1px solid var(--vscode-panel-border); color: var(--vscode-foreground); }
  .rv-file { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.8em; color: var(--vscode-textLink-foreground); background: var(--vscode-editor-inactiveSelectionBackground); padding: 2px 6px; border-radius: 3px; margin-bottom: 5px; display: inline-block; }
  .rv-score { font-size: 0.88em; font-weight: 600; margin: 6px 0; color: var(--vscode-foreground); }
  .rv-list { margin: 3px 0 3px 14px; padding: 0; }
  .rv-list li { margin-bottom: 5px; font-size: 0.82em; line-height: 1.45; }
  .rv-list li strong { color: var(--vscode-foreground); }
  .rv-list li code, .rv-para code { font-family: var(--vscode-editor-font-family, monospace); background: var(--vscode-editor-inactiveSelectionBackground); padding: 0 3px; border-radius: 2px; font-size: 0.9em; }
  .rv-para { font-size: 0.82em; margin: 2px 0; line-height: 1.4; }
  .rv-divider { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 10px 0; }
  @media print {
    body { background: #fff; color: #000; padding: 20px; font-family: sans-serif; font-size: 11pt; }
    .webhook-bar, #mainPanel, #unconfiguredHint, .review-toolbar { display: none !important; }
    .review-result-wrap { max-height: none; overflow: visible; border: none; padding: 0; background: transparent; }
    .rv-h1 { font-size: 13pt; font-weight: bold; margin: 14px 0 6px; color: #000; }
    .rv-h2 { font-size: 11pt; font-weight: bold; margin: 10px 0 4px; border-bottom: 1px solid #ccc; color: #000; }
    .rv-file { font-family: monospace; font-size: 9pt; background: #f0f0f0; padding: 1px 5px; border-radius: 2px; color: #333; }
    .rv-score { font-weight: bold; font-size: 10pt; color: #000; }
    .rv-list { margin: 3px 0 3px 16px; padding: 0; }
    .rv-list li { font-size: 10pt; margin-bottom: 4px; line-height: 1.5; color: #000; }
    .rv-para { font-size: 10pt; margin: 2px 0; line-height: 1.5; color: #000; }
    .rv-divider { border-top: 1px solid #ccc; margin: 10px 0; }
    code { font-family: monospace; background: #f0f0f0; padding: 0 3px; border-radius: 2px; font-size: 9pt; }
    a { color: #000; text-decoration: none; }
    h2 { display: none; }
  }
</style>
</head>
<body>

<h2>AI Code Review</h2>

<!-- Webhook status bar -->
<div class="webhook-bar">
  <div class="dot${webhookConfigured ? ' ok' : ''}" id="webhookDot"></div>
  <span class="webhook-label" id="webhookLabel">${webhookConfigured ? 'Webhook configured' : 'Webhook not configured'}</span>
  <button id="configBtn">Configure</button>
</div>

<!-- Hint shown when not configured -->
<p class="unconfigured-hint${webhookConfigured ? '' : ' visible'}" id="unconfiguredHint">
  &#x26A0;&#xFE0F; Configure the webhook URL above to enable reviews.
</p>

<!-- Main panel locked until configured -->
<div id="mainPanel"${webhookConfigured ? '' : ' class="locked"'}>

  <div class="radio-group" id="radioGroup">
    <label><input type="radio" name="reviewType" value="full" checked/> Git Unstaged Diff</label>
    <label><input type="radio" name="reviewType" value="file"/> Git Selected Files</label>
    <label><input type="radio" name="reviewType" value="commit"/> Git Commit Review</label>
    <label><input type="radio" name="reviewType" value="flatfile"/> Flat File Review</label>
  </div>

  <!-- Git Selected Files extras -->
  <div class="extra" id="fileExtras">
    <div class="select-bar">
      <a id="selectAll">Select all</a>
      <a id="selectNone">None</a>
    </div>
    <div id="fileList"><em style="font-size:0.82em;color:var(--vscode-descriptionForeground)">Loading&hellip;</em></div>
  </div>

  <!-- Git Commit Review extras -->
  <div class="extra" id="commitExtras">
    <label for="commitIdInput">Commit SHA <span style="color:var(--vscode-errorForeground)">*</span></label>
    <input type="text" id="commitIdInput" placeholder="e.g. a3f5c92" spellcheck="false"/>
    <label for="repoPathInput">Repository path <span style="font-weight:400">(optional &mdash; leave blank for current workspace)</span></label>
    <input type="text" id="repoPathInput" placeholder="e.g. C:/projects/my-repo" spellcheck="false"/>
  </div>

  <!-- Flat File Review extras -->
  <div class="extra" id="flatFileExtras">
    <label for="flatFilePathInput">File path(s) <span style="color:var(--vscode-errorForeground)">*</span> <span style="font-weight:400">(one per line)</span></label>
    <textarea id="flatFilePathInput" rows="4" placeholder="e.g.&#10;src/utils/helpers.ts&#10;src/models/user.ts&#10;C:/projects/my-repo/file.ts" spellcheck="false"></textarea>
  </div>

  <button id="reviewBtn">Start Review</button>
</div>

<div id="output"></div>

<script>
  // Catch any JS error and display it so we can diagnose
  window.onerror = function(msg, src, line) {
    var out = document.getElementById('output');
    if (out) out.innerHTML = '<div style="background:rgba(200,0,0,0.3);padding:8px;font-size:0.8em;border-radius:4px;word-break:break-all"><strong>JS Error (line '+line+'):</strong><br/>'+String(msg)+'</div>';
    return false;
  };

  const vscode       = acquireVsCodeApi();
  const configBtn    = document.getElementById('configBtn');
  const reviewBtn    = document.getElementById('reviewBtn');
  const output       = document.getElementById('output');
  const webhookDot   = document.getElementById('webhookDot');
  const webhookLabel = document.getElementById('webhookLabel');
  const mainPanel    = document.getElementById('mainPanel');
  const hint         = document.getElementById('unconfiguredHint');
  const fileExtras       = document.getElementById('fileExtras');
  const commitExtras     = document.getElementById('commitExtras');
  const flatFileExtras   = document.getElementById('flatFileExtras');
  const fileList         = document.getElementById('fileList');
  const commitInput      = document.getElementById('commitIdInput');
  const repoInput        = document.getElementById('repoPathInput');
  const flatFilePathInput = document.getElementById('flatFilePathInput');

  let webhookReady = ${webhookConfigured};
  var lastReviewText = '';

  // \u2500\u2500 Markdown renderer \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function fmtInline(text) {
    // Escape HTML first, then apply markdown
    var e = esc(text);
    e = e.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    e = e.replace(/\\x60([^\\x60]+)\\x60/g, '<code>$1</code>');
    return e;
  }

  function fmtInlineWithLinks(text, currentFile) {
    var e = esc(text);
    e = e.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    e = e.replace(/\\x60([^\\x60]+)\\x60/g, '<code>$1</code>');
    if (currentFile) {
      e = e.replace(/\\b[Ll]ine[s]?\\s+(\\d+)/g, function(match, lineNum) {
        return '<a class="line-link" href="#" data-file="' + esc(currentFile) + '" data-line="' + lineNum + '">' + match + '</a>';
      });
    }
    return e;
  }

  function renderReview(text) {
    var sections = text.split(/^-{3,}$/m).map(function(s){ return s.trim(); }).filter(Boolean);
    var html = '';
    sections.forEach(function(section, idx) {
      if (idx > 0) { html += '<hr class="rv-divider"/>'; }
      html += '<div class="rv-section">';
      var lines = section.split('\\n');
      var inList = false;
      var currentFile = '';
      lines.forEach(function(line) {
        var t = line.trim();
        if (!t) { if (inList) { html += '</ul>'; inList = false; } return; }
        if (t.startsWith('- ')) {
          if (!inList) { html += '<ul class="rv-list">'; inList = true; }
          html += '<li>' + fmtInlineWithLinks(t.slice(2), currentFile) + '</li>';
        } else {
          if (inList) { html += '</ul>'; inList = false; }
          if (t.startsWith('File:')) {
            currentFile = t.replace(/^File:\\s*/, '').trim();
            html += '<div class="rv-file"><a class="file-link" href="#" data-file="' + esc(currentFile) + '" data-line="1">' + esc(t) + '</a></div>';
          } else if (/^(Change Score|Coverage|Covered|Missing|Suggested):/.test(t)) {
            html += '<div class="rv-score">' + fmtInlineWithLinks(t, currentFile) + '</div>';
          } else if (/^[A-Z][A-Za-z ]+:$/.test(t)) {
            html += '<h3 class="rv-h2">' + esc(t.slice(0, -1)) + '</h3>';
          } else if (/^[A-Z]/.test(t) && t.length < 50 && !t.includes('.')) {
            html += '<h2 class="rv-h1">' + esc(t) + '</h2>';
          } else {
            html += '<p class="rv-para">' + fmtInlineWithLinks(t, currentFile) + '</p>';
          }
        }
      });
      if (inList) { html += '</ul>'; }
      html += '</div>';
    });
    return html;
  }

  // ── Webhook status ──────────────────────────────────────────────────────
  function setWebhookStatus(configured) {
    webhookReady = configured;
    webhookDot.className = 'dot' + (configured ? ' ok' : '');
    webhookLabel.textContent = configured ? 'Webhook configured' : 'Webhook not configured';
    if (configured) {
      mainPanel.classList.remove('locked');
      hint.classList.remove('visible');
    } else {
      mainPanel.classList.add('locked');
      hint.classList.add('visible');
    }
  }

  // ── Review type switching ───────────────────────────────────────────────
  document.querySelectorAll('input[name="reviewType"]').forEach(radio => {
    radio.addEventListener('change', () => onTypeChange(radio.value));
  });

  function onTypeChange(type) {
    fileExtras.classList.toggle('visible', type === 'file');
    commitExtras.classList.toggle('visible', type === 'commit');
    flatFileExtras.classList.toggle('visible', type === 'flatfile');
    if (type === 'file') {
      loadChangedFiles();
    } else if (type === 'commit' || type === 'flatfile') {
      syncReviewBtn();
    } else {
      reviewBtn.disabled = false;
    }
  }

  // ── Changed file list ───────────────────────────────────────────────────
  function loadChangedFiles() {
    document.getElementById('selectAll').parentElement.style.display = 'none';
    fileList.innerHTML = '<em style="font-size:0.82em;color:var(--vscode-descriptionForeground)">Loading&hellip;</em>';
    vscode.postMessage({ command: 'requestChangedFiles' });
  }

  function renderFileList(files) {
    var selectBar = document.getElementById('selectAll').parentElement;
    if (!files || files.length === 0) {
      fileList.innerHTML = '<em style="font-size:0.82em;color:var(--vscode-descriptionForeground)">No unstaged changes found.</em>';
      selectBar.style.display = 'none';
      reviewBtn.disabled = true;
      return;
    }
    selectBar.style.display = '';
    fileList.innerHTML = files.map(function(f) {
      var ef = esc(f);
      return '<div class="file-item">' +
        '<input type="checkbox" id="f_' + ef + '" value="' + ef + '" checked/>' +
        '<span title="' + ef + '">' + ef + '</span>' +
        '</div>';
    }).join('');
    // listen for checkbox changes to gate the button
    fileList.querySelectorAll('input[type=checkbox]').forEach(function(cb) {
      cb.addEventListener('change', syncReviewBtn);
    });
    syncReviewBtn();
  }

  function syncReviewBtn() {
    var type = document.querySelector('input[name="reviewType"]:checked').value;
    if (type === 'file') {
      reviewBtn.disabled = fileList.querySelectorAll('input[type=checkbox]:checked').length === 0;
    } else if (type === 'commit') {
      reviewBtn.disabled = !/^[0-9a-fA-F]{7,64}$/.test(commitInput.value.trim());
    } else if (type === 'flatfile') {
      reviewBtn.disabled = flatFilePathInput.value.split('\\n').map(function(s){ return s.trim(); }).filter(Boolean).length === 0;
    } else {
      reviewBtn.disabled = false;
    }
  }

  // Validate commit SHA and flat file path on every keystroke
  commitInput.addEventListener('input', syncReviewBtn);
  flatFilePathInput.addEventListener('input', syncReviewBtn);

  document.getElementById('selectAll').addEventListener('click', () => {
    fileList.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = true; });
    syncReviewBtn();
  });
  document.getElementById('selectNone').addEventListener('click', () => {
    fileList.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = false; });
    syncReviewBtn();
  });

  function getSelectedFiles() {
    return [...fileList.querySelectorAll('input[type=checkbox]:checked')].map(cb => cb.value);
  }

  // ── HTML escaping ───────────────────────────────────────────────────────
  function esc(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Button handlers ─────────────────────────────────────────────────────
  configBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'configureWebhook' });
  });

  reviewBtn.addEventListener('click', () => {
    const reviewType = document.querySelector('input[name="reviewType"]:checked').value;
    const payload = { command: 'startReview', reviewType };

    if (reviewType === 'file') {
      const selected = getSelectedFiles();
      if (selected.length === 0) {
        output.innerHTML = '<div class="msg error">&#x274C; Please select at least one file.</div>';
        return;
      }
      payload.selectedFiles = selected;
    } else if (reviewType === 'commit') {
      const cid = commitInput.value.trim();
      if (!/^[0-9a-fA-F]{7,64}$/.test(cid)) {
        output.innerHTML = '<div class="msg error">&#x274C; Invalid commit SHA &mdash; must be 7&ndash;64 hex characters.</div>';
        return;
      }
      payload.commitId  = cid;
      payload.repoPath  = repoInput.value.trim();
    } else if (reviewType === 'flatfile') {
      const fps = flatFilePathInput.value.split('\\n').map(function(s){ return s.trim(); }).filter(Boolean);
      if (fps.length === 0) {
        output.innerHTML = '<div class="msg error">&#x274C; Please enter at least one file path.</div>';
        return;
      }
      payload.flatFilePaths = fps;
    }

    vscode.postMessage(payload);
  });

  // ── File / line link handler ────────────────────────────────────────────
  output.addEventListener('click', function(e) {
    var link = e.target && e.target.closest ? e.target.closest('.file-link, .line-link') : null;
    if (!link) { return; }
    e.preventDefault();
    vscode.postMessage({ command: 'openFile', filePath: link.dataset.file, line: parseInt(link.dataset.line, 10) || 1 });
  });

  // ── Message handler ─────────────────────────────────────────────────────
  window.addEventListener('message', event => {
    const msg = event.data;

    if (msg.type === 'webhookStatus') {
      setWebhookStatus(msg.configured);

    } else if (msg.type === 'changedFiles') {
      renderFileList(msg.files);

    } else if (msg.type === 'reviewStart') {
      reviewBtn.disabled = true;
      output.innerHTML = '<div class="msg info">&#x23F3; Running review&hellip;</div>';

    } else if (msg.type === 'reviewCancelled') {
      reviewBtn.disabled = false;
      output.innerHTML = '<div class="msg info">Review cancelled.</div>';

    } else if (msg.type === 'reviewError') {
      reviewBtn.disabled = false;
      output.innerHTML = '<div class="msg error">&#x274C; ' + esc(msg.message).replace(/\\n/g, '<br/>') + '</div>';

    } else if (msg.type === 'reviewResult') {
      reviewBtn.disabled = false;
      lastReviewText = msg.review || '';
      var reviewFiles = msg.files || [];
      var renderedHtml = renderReview(lastReviewText);
      var filesBullets = reviewFiles.length
        ? '<div class="review-files-box"><ul>' + reviewFiles.map(function(f){ return '<li>' + esc(f) + '</li>'; }).join('') + '</ul></div>'
        : '';
      output.innerHTML =
        '<div class="review-toolbar">' +
          filesBullets +
          '<div class="toolbar-btns">' +
            '<button class="open-btn" id="copyReviewBtn">Copy</button>' +
            '<button class="open-btn" id="openNewTabBtn">Open in New Tab</button>' +
            '<button class="open-btn" id="downloadPdfBtn">Download as PDF</button>' +
          '</div>' +
        '</div>' +
        '<div class="review-result-wrap">' + renderedHtml + '</div>';
      document.getElementById('copyReviewBtn').addEventListener('click', function() {
        navigator.clipboard.writeText(lastReviewText).then(function() {
          var btn = document.getElementById('copyReviewBtn');
          btn.textContent = 'Copied!';
          setTimeout(function() { btn.textContent = 'Copy'; }, 2000);
        });
      });
      document.getElementById('openNewTabBtn').addEventListener('click', function() {
        vscode.postMessage({ command: 'openInNewWindow', content: lastReviewText });
      });
      document.getElementById('downloadPdfBtn').addEventListener('click', function() {
        vscode.postMessage({ command: 'downloadPdf', htmlContent: renderedHtml, reviewFiles: reviewFiles });
      });
    }
  });

  // Signal ready (still sent so extension can react to future reloads)
  vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
  }
}
