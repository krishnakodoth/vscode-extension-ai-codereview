import * as vscode from 'vscode';
import { AiReviewProvider } from './AiReviewProvider';

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('AI Code Review');
  output.appendLine('AI Review Extension activated');

  const provider = vscode.window.registerWebviewViewProvider(
    AiReviewProvider.viewType,
    new AiReviewProvider(context.extensionUri)
  );

  context.subscriptions.push(output, provider);
}

export function deactivate(): void {
  // VS Code disposes all context.subscriptions automatically on deactivation
}