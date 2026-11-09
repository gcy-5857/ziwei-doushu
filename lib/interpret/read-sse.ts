/**
 * 浏览器侧读取 /api/interpret 的 SSE。
 *
 * 协议与 ChatPanel / InsightPanel 原来一致：
 *   data: {"delta":{"text":"..."}}
 *   data: [DONE]
 * 网络分片会把一行拆开，也可能把一个 UTF-8 字符拆开。这里跨 chunk 缓冲，
 * 流在 [DONE] 之前结束或读失败时保留已收到的文本，并标记为中断。
 */

export interface InterpretSseResult {
  text: string;
  /** 收到了 `data: [DONE]`。 */
  completed: boolean;
  /** 流结束或出错时还没有看到 [DONE]。已收到的 text 仍然有效。 */
  interrupted: boolean;
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

export async function readInterpretSse(
  body: ReadableStream<Uint8Array>,
  onText: (text: string) => void,
): Promise<InterpretSseResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let text = '';
  let completed = false;

  const consume = (lines: string[]): boolean => {
    for (const raw of lines) {
      const line = stripCr(raw);
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') return true;
      try {
        const delta = JSON.parse(data).delta?.text;
        if (typeof delta !== 'string' || delta.length === 0) continue;
        text += delta;
        onText(text);
      } catch {
        // 半行或坏 JSON 不能吃掉后面的事件；半行由 pending 保住，这里只跳过坏事件。
      }
    }
    return false;
  };

  try {
    while (!completed) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      if (consume(lines)) completed = true;
    }
    if (!completed) {
      pending += decoder.decode();
      if (pending.length > 0 && consume(pending.split('\n'))) completed = true;
    }
  } catch {
    return { text, completed: false, interrupted: true };
  } finally {
    try { reader.releaseLock(); } catch { /* 已释放 */ }
  }

  return { text, completed, interrupted: !completed };
}
