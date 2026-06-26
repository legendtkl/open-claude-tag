import { spawn } from 'node:child_process';

export interface LarkCliOptions {
  /** Path to lark-cli binary. Defaults to LARK_CLI_PATH env var or 'lark-cli'. */
  binaryPath?: string;
  /** Timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number;
}

export interface LarkCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Parsed JSON from stdout, if valid JSON. */
  data?: unknown;
}

export class LarkCli {
  private readonly binaryPath: string;
  private readonly timeoutMs: number;

  constructor(options: LarkCliOptions = {}) {
    this.binaryPath = options.binaryPath ?? process.env.LARK_CLI_PATH ?? 'lark-cli';
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Run any lark-cli command with the given arguments. */
  exec(args: string[]): Promise<LarkCliResult> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.binaryPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));

      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`lark-cli timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        let data: unknown;
        try {
          data = JSON.parse(stdout);
        } catch {
          // stdout is not JSON — leave data undefined
        }
        resolve({ stdout, stderr, exitCode: code ?? 1, data });
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /** Check if lark-cli binary is available. */
  async isAvailable(): Promise<boolean> {
    try {
      const result = await this.exec(['--version']);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  /** Run lark-cli doctor health check. */
  doctor(): Promise<LarkCliResult> {
    return this.exec(['doctor']);
  }

  /** Send a text message to a chat. */
  sendText(chatId: string, text: string): Promise<LarkCliResult> {
    return this.exec(['im', '+messages-send', '--chat-id', chatId, '--text', text]);
  }

  /** Send a markdown message to a chat. */
  sendMarkdown(chatId: string, markdown: string): Promise<LarkCliResult> {
    return this.exec(['im', '+messages-send', '--chat-id', chatId, '--markdown', markdown]);
  }

  /** Send an interactive card to a chat. */
  sendCard(chatId: string, cardContent: Record<string, unknown>): Promise<LarkCliResult> {
    return this.exec([
      'im', '+messages-send',
      '--chat-id', chatId,
      '--msg-type', 'interactive',
      '--content', JSON.stringify(cardContent),
    ]);
  }

  /**
   * Update (PATCH) an existing message card.
   *
   * Note: The Feishu PATCH /im/v1/messages API requires `content` to be a
   * JSON **string** inside the request body (not an object). This means
   * `cardContent` is serialized twice: once for the `content` field value,
   * and once for the outer `--data` payload. This is intentional and matches
   * the Feishu API contract.
   */
  updateCard(messageId: string, cardContent: Record<string, unknown>): Promise<LarkCliResult> {
    return this.exec([
      'api', 'PATCH', `/open-apis/im/v1/messages/${messageId}`,
      '--data', JSON.stringify({ msg_type: 'interactive', content: JSON.stringify(cardContent) }),
    ]);
  }

  /** Search for chats by keyword. */
  searchChat(query: string): Promise<LarkCliResult> {
    return this.exec(['im', '+chat-search', '--query', query]);
  }

  /** List recent messages in a chat. */
  listMessages(chatId: string, pageSize = 10): Promise<LarkCliResult> {
    return this.exec([
      'im', '+chat-messages-list',
      '--chat-id', chatId,
      '--page-size', String(pageSize),
    ]);
  }
}
