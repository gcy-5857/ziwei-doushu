/**
 * POST /api/interpret
 *
 * 浏览器请求：{ chart, messages: [{ role: 'user' | 'assistant', content }] }
 * 响应：text/event-stream
 *   data: {"delta":{"text":"..."}}
 *   data: [DONE]
 *
 * 上游是 DeepSeek 官方 OpenAI 兼容 Chat Completions（stream: true）。
 * 只读服务端环境变量 DEEPSEEK_API_KEY；可选 DEEPSEEK_BASE_URL、DEEPSEEK_MODEL。
 * 默认模型 deepseek-flash（2026-07-24 起 deepseek-chat / deepseek-reasoner 已停用），
 * 并关闭默认开启的思考模式，避免把推理 token 算进输出费用。
 */

import { BRANCHES, STEMS } from '../ziwei/constants';

export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
/** 官方价格表里的经济档。思考模式默认开着，本接口显式关闭。 */
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-flash';
export const DEFAULT_TIMEOUT_MS = 45_000;

const MAX_BODY_BYTES = 256 * 1024;
const MAX_MESSAGES = 24;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_TOTAL_MESSAGE_CHARS = 24_000;
const MAX_OUTPUT_TOKENS = 2_048;

const DISCLAIMER_RULE =
  '以上为传统文化娱乐参考，并非对健康、财富或命运的确定性结论。';

export interface InterpretDeps {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  /** 测试注入。生产路径用 DEFAULT_TIMEOUT_MS。 */
  timeoutMs?: number;
}

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 6) out = out.split(secret).join('[redacted]');
  }
  out = out.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  out = out.replace(/\bsk-[A-Za-z0-9_-]{4,}\b/g, 'sk-[redacted]');
  return out.slice(0, 240);
}

function jsonError(status: number, code: string, message: string, secrets: readonly string[]): Response {
  const body = JSON.stringify({ error: code, message: redactSecrets(message, secrets) });
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function readConfig(env: Record<string, string | undefined>): { key: string; endpoint: string; model: string } {
  const rawKey = env.DEEPSEEK_API_KEY ?? '';
  const key = rawKey.trim();
  if (!key) throw new HttpError(503, 'missing_config', '未配置服务端环境变量 DEEPSEEK_API_KEY');
  if (key.length > 256 || !/^[\x21-\x7E]+$/.test(key)) {
    throw new HttpError(503, 'invalid_config', 'DEEPSEEK_API_KEY 格式无效');
  }

  const model = (env.DEEPSEEK_MODEL ?? '').trim() || DEFAULT_DEEPSEEK_MODEL;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(model)) {
    throw new HttpError(503, 'invalid_config', 'DEEPSEEK_MODEL 无效');
  }

  const endpoint = resolveEndpoint(env.DEEPSEEK_BASE_URL);
  return { key, endpoint, model };
}

function resolveEndpoint(raw: string | undefined): string {
  const base = (raw ?? '').trim() || DEFAULT_DEEPSEEK_BASE_URL;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new HttpError(503, 'invalid_config', 'DEEPSEEK_BASE_URL 无效');
  }
  if (url.username || url.password) {
    throw new HttpError(503, 'invalid_config', 'DEEPSEEK_BASE_URL 无效');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new HttpError(503, 'invalid_config', 'DEEPSEEK_BASE_URL 无效');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function readBody(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared) {
    const size = Number(declared);
    if (!Number.isFinite(size) || size < 0) throw new HttpError(400, 'invalid_request', '请求体无效');
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', '请求体过大');
  }
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media', 'Content-Type 需要 application/json');
  }
  if (!request.body) throw new HttpError(400, 'invalid_request', '请求体为空');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413, 'payload_too_large', '请求体过大');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid_request', '请求体无法读取');
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, 'invalid_request', '请求体不是 UTF-8');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_request', '请求体不是 JSON');
  }
}

function requireInteger(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

function validateChart(chart: unknown): Record<string, unknown> {
  if (!isRecord(chart)) throw new HttpError(400, 'invalid_request', '缺少命盘');
  const birth = chart.birthInfo;
  if (!isRecord(birth)) throw new HttpError(400, 'invalid_request', '命盘缺少出生信息');
  if (requireInteger(birth.year, 1, 3000) === null) throw new HttpError(400, 'invalid_request', '出生年份无效');
  if (requireInteger(birth.month, 1, 12) === null) throw new HttpError(400, 'invalid_request', '出生月份无效');
  if (requireInteger(birth.day, 1, 31) === null) throw new HttpError(400, 'invalid_request', '出生日无效');
  if (requireInteger(birth.hour, 0, 11) === null) throw new HttpError(400, 'invalid_request', '时辰序号无效');
  if (birth.gender !== 'male' && birth.gender !== 'female') {
    throw new HttpError(400, 'invalid_request', '性别无效');
  }
  if (!Array.isArray(chart.palaces) || chart.palaces.length !== 12) {
    throw new HttpError(400, 'invalid_request', '命盘需要 12 宫');
  }
  for (const palace of chart.palaces) {
    if (!isRecord(palace) || typeof palace.name !== 'string' || !Array.isArray(palace.stars)) {
      throw new HttpError(400, 'invalid_request', '宫位数据无效');
    }
  }
  return chart;
}

function validateMessages(value: unknown): ChatTurn[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGES) {
    throw new HttpError(400, 'invalid_request', '消息数量无效');
  }
  let total = 0;
  const turns: ChatTurn[] = [];
  for (const item of value) {
    if (!isRecord(item)) throw new HttpError(400, 'invalid_request', '消息格式无效');
    if (item.role !== 'user' && item.role !== 'assistant') {
      throw new HttpError(400, 'invalid_request', '消息角色无效');
    }
    if (typeof item.content !== 'string') throw new HttpError(400, 'invalid_request', '消息内容无效');
    const content = item.content;
    if (content.trim().length === 0 || content.length > MAX_MESSAGE_CHARS) {
      throw new HttpError(400, 'invalid_request', '消息长度无效');
    }
    total += content.length;
    if (total > MAX_TOTAL_MESSAGE_CHARS) throw new HttpError(400, 'invalid_request', '对话过长');
    turns.push({ role: item.role, content });
  }
  if (!turns.some(turn => turn.role === 'user')) {
    throw new HttpError(400, 'invalid_request', '缺少用户问题');
  }
  return turns;
}

function starLabel(star: unknown): string {
  if (!isRecord(star) || typeof star.name !== 'string' || star.name.length === 0 || star.name.length > 32) return '';
  const brightness = typeof star.brightnessRaw === 'string' ? star.brightnessRaw : '';
  const siHua = star.siHua === '禄' || star.siHua === '权' || star.siHua === '科' || star.siHua === '忌'
    ? `化${star.siHua}`
    : '';
  return `${star.name}${brightness}${siHua}`;
}

function summarizeChart(chart: Record<string, unknown>): string {
  const birth = chart.birthInfo as Record<string, unknown>;
  const hour = birth.hour as number;
  const gender = birth.gender === 'male' ? '男' : '女';
  const lines: string[] = [];
  lines.push(`公历 ${birth.year}-${birth.month}-${birth.day}，时辰序号 ${hour}（${BRANCHES[hour] ?? '?'}），${gender}`);
  if (typeof birth.city === 'string' && birth.city.length > 0 && birth.city.length <= 40) {
    const province = typeof birth.province === 'string' ? birth.province.slice(0, 40) : '';
    lines.push(`出生地 ${province}${birth.city}`);
  }
  if (typeof chart.wuxingJuName === 'string') lines.push(`五行局 ${chart.wuxingJuName}`);
  if (typeof chart.yinYangGender === 'string') lines.push(`阴阳 ${chart.yinYangGender}`);
  if (typeof chart.mingZhu === 'string') lines.push(`命主 ${chart.mingZhu}，身主 ${typeof chart.shenZhu === 'string' ? chart.shenZhu : ''}`);
  const lunar = isRecord(chart.lunarInfo) ? chart.lunarInfo : null;
  const pillars = lunar && Array.isArray(lunar.fourPillars) ? lunar.fourPillars.filter(item => typeof item === 'string').slice(0, 4) : [];
  if (pillars.length === 4) lines.push(`四柱 ${pillars.join(' ')}`);
  if (typeof chart.currentAge === 'number') lines.push(`推算年龄 ${chart.currentAge}`);

  const palaces = chart.palaces as Record<string, unknown>[];
  for (const palace of palaces) {
    const branch = typeof palace.branch === 'number' ? BRANCHES[palace.branch] ?? '' : '';
    const stem = typeof palace.stem === 'number' ? STEMS[palace.stem] ?? '' : '';
    const stars = (palace.stars as unknown[]).map(starLabel).filter(Boolean).join('、') || '无星';
    const flags = [
      palace.isMingGong ? '命宫' : '',
      palace.isShenGong ? '身宫' : '',
      palace.isCurrentDaXian ? '当前大限' : '',
    ].filter(Boolean).join('/');
    const ages = Array.isArray(palace.daXianAge)
      && palace.daXianAge.length === 2
      && typeof palace.daXianAge[0] === 'number'
      && typeof palace.daXianAge[1] === 'number'
      ? ` 大限${palace.daXianAge[0]}-${palace.daXianAge[1]}`
      : '';
    const borrowed = palace.isEmpty
      ? ` 空宫借${typeof palace.borrowedFromName === 'string' ? palace.borrowedFromName : '对宫'}`
      : '';
    lines.push(`${palace.name} ${stem}${branch}${flags ? `（${flags}）` : ''}：${stars}${ages}${borrowed}`);
  }

  const text = lines.join('\n');
  return text.length > 12_000 ? `${text.slice(0, 12_000)}\n…（摘要已截断）` : text;
}

function systemPrompt(chart: Record<string, unknown>): string {
  return [
    '你是紫微斗数文化讲解助手，按倪海厦《天纪》体系的常见讲法解释下面这份命盘。',
    '必须遵守：',
    '1. 定位是传统文化娱乐参考，不是医疗、理财或命运裁决。',
    '2. 健康只可谈传统说法中的留意方向，并写明不能代替就医；禁止诊断、处方和病程断言。',
    '3. 财富、事业、感情、寿元只谈盘面倾向和处事上的参考，禁止使用「一定」「必然」「注定」「保证」等确定性断言。',
    '4. 只使用命盘摘要里出现的星曜、宫位和四化，不要编造。命理专名保留中文。',
    '5. 用简体中文，按用户要求的结构回答，篇幅适中。',
    `6. 结尾用一句话标明：${DISCLAIMER_RULE}`,
    '',
    '命盘摘要：',
    summarizeChart(chart),
  ].join('\n');
}

function splitSseLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  return {
    lines: parts.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line)),
    rest,
  };
}

type LineOutcome = 'continue' | 'done' | 'fail';

function forwardUpstreamLine(line: string, emit: (text: string) => void): LineOutcome {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return 'continue';
  const data = trimmed.slice(5).trim();
  if (data === '[DONE]') return 'done';
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return 'continue';
  }
  if (!isRecord(parsed)) return 'continue';
  if (parsed.error) return 'fail';
  const choices = parsed.choices;
  if (!Array.isArray(choices) || !isRecord(choices[0])) return 'continue';
  const delta = choices[0].delta;
  if (!isRecord(delta)) return 'continue';
  const content = delta.content;
  if (typeof content === 'string' && content.length > 0) emit(content);
  return 'continue';
}

function translateUpstream(upstream: ReadableStream<Uint8Array>, signal: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      reader = upstream.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let clean = false;
      const emit = (text: string) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: { text } })}\n\n`));
      };
      const take = (lines: string[]): LineOutcome => {
        for (const line of lines) {
          const outcome = forwardUpstreamLine(line, emit);
          if (outcome !== 'continue') return outcome;
        }
        return 'continue';
      };
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          const split = splitSseLines(pending);
          pending = split.rest;
          const outcome = take(split.lines);
          if (outcome === 'done') { clean = true; break; }
          if (outcome === 'fail') break;
        }
        if (!signal.aborted && !clean && pending.length > 0) {
          pending += decoder.decode();
          const outcome = take(splitSseLines(`${pending}\n`).lines);
          if (outcome === 'done') clean = true;
        } else if (!signal.aborted && !clean) {
          pending += decoder.decode();
        }
        if (clean && !signal.aborted) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        }
        controller.close();
      } catch {
        try { controller.close(); } catch { /* 客户端已离开 */ }
      }
    },
    cancel() {
      return reader?.cancel();
    },
  });
}

function isTimeout(timeoutSignal: AbortSignal, requestSignal: AbortSignal): boolean {
  return timeoutSignal.aborted && !requestSignal.aborted;
}

export async function handleInterpret(request: Request, deps: InterpretDeps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const secrets: string[] = [];

  try {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', '只接受 POST');
    const { key, endpoint, model } = readConfig(env);
    secrets.push(key);
    const payload = await readBody(request);
    if (!isRecord(payload)) throw new HttpError(400, 'invalid_request', '请求体无效');
    const chart = validateChart(payload.chart);
    const messages = validateMessages(payload.messages);

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeoutSignal])
      : timeoutSignal;

    let upstream: Response;
    try {
      upstream = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: systemPrompt(chart) }, ...messages],
          stream: true,
          temperature: 0.7,
          max_tokens: MAX_OUTPUT_TOKENS,
          thinking: { type: 'disabled' },
        }),
      });
    } catch (error) {
      if (request.signal?.aborted) return new Response(null, { status: 499 });
      if (isTimeout(timeoutSignal, request.signal)) {
        return jsonError(504, 'timeout', '上游超时', secrets);
      }
      const reason = error instanceof Error ? error.message : '上游连接失败';
      return jsonError(502, 'upstream_error', reason, secrets);
    }

    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => undefined);
      return jsonError(502, 'upstream_error', `上游返回 ${upstream.status}`, secrets);
    }
    if (!upstream.body) return jsonError(502, 'upstream_error', '上游没有响应流', secrets);

    return new Response(translateUpstream(upstream.body, signal), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    if (error instanceof HttpError) return jsonError(error.status, error.code, error.message, secrets);
    return jsonError(500, 'internal_error', '解读服务暂时不可用', secrets);
  }
}
