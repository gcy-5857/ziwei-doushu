import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { generateChart } from '../../lib/ziwei/algorithm';
import { handleInterpret } from '../../lib/interpret/handle';
import { readInterpretSse } from '../../lib/interpret/read-sse';

const SECRET = 'sk-test-do-not-leak';
const savedEnv = {
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL,
};
delete process.env.DEEPSEEK_API_KEY;
delete process.env.DEEPSEEK_BASE_URL;
delete process.env.DEEPSEEK_MODEL;

function restoreEnv() {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

const chart = generateChart({ year: 1990, month: 1, day: 1, hour: 0, gender: 'female' });
assert.equal(chart.palaces.length, 12, '排盘不依赖 DEEPSEEK_API_KEY');

function envOf(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { DEEPSEEK_API_KEY: SECRET, ...extra };
}

function post(body: unknown, init: RequestInit = {}): Request {
  return new Request('http://127.0.0.1/api/interpret', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });
}

function payload(messages: { role: string; content: string }[] = [{ role: 'user', content: '请看命格' }]) {
  const copy = JSON.parse(JSON.stringify(chart)) as typeof chart & { birthInfo: { name?: string } };
  copy.birthInfo.name = 'fixture-name';
  return { chart: copy, messages };
}

function assertNoSecret(text: string) {
  assert.equal(text.includes(SECRET), false);
  assert.equal(/Bearer\s+sk-/i.test(text), false);
}

async function readJson(res: Response): Promise<{ error?: string; message?: string }> {
  const text = await res.text();
  assertNoSecret(text);
  return JSON.parse(text) as { error?: string; message?: string };
}

function chunksOf(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}

function byteStream(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  const parts = chunksOf(bytes, size);
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

function upstreamSse(parts: string[]): string {
  return parts.map(part => `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { content: part, reasoning_content: `thought-${SECRET}` } }],
  })}\n`).join('') + 'data: [DONE]\n';
}

interface Captured {
  url: string;
  init: RequestInit;
  body: { model?: string; stream?: boolean; temperature?: number; max_tokens?: number; thinking?: { type?: string }; messages?: { role: string; content: string }[] };
}

function mockFetch(sse: string | ReadableStream<Uint8Array>, status = 200) {
  let captured: Captured | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const raw = typeof init?.body === 'string' ? init.body : '';
    captured = { url, init: init ?? {}, body: raw ? JSON.parse(raw) : {} };
    assert.equal(raw.includes(SECRET), false, '上游请求体不能带上 API Key');
    assert.equal(url.includes(SECRET), false);
    const body = typeof sse === 'string' ? byteStream(new TextEncoder().encode(sse), 3) : sse;
    return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { fetchImpl, take: () => captured };
}

async function main() {
  const keepalive = setInterval(() => {}, 1_000);
  try {
  let calls = 0;
  const noFetch: typeof fetch = async () => {
    calls += 1;
    throw new Error('fetch should not run');
  };

  const missing = await handleInterpret(post(payload()), { env: {}, fetchImpl: noFetch });
  assert.equal(missing.status, 503);
  assert.equal((await readJson(missing)).error, 'missing_config');
  assert.equal(calls, 0);

  const blank = await handleInterpret(post(payload()), { env: { DEEPSEEK_API_KEY: '   ' }, fetchImpl: noFetch });
  assert.equal(blank.status, 503);
  assert.equal((await readJson(blank)).error, 'missing_config');

  const injected = await handleInterpret(post(payload()), {
    env: { DEEPSEEK_API_KEY: `${SECRET}\nX-Injected: 1` },
    fetchImpl: noFetch,
  });
  assert.equal(injected.status, 503);
  assert.equal((await readJson(injected)).error, 'invalid_config');
  assert.equal(calls, 0);

  const badModel = await handleInterpret(post(payload()), {
    env: envOf({ DEEPSEEK_MODEL: 'not a model' }),
    fetchImpl: noFetch,
  });
  assert.equal(badModel.status, 503);
  assert.equal((await readJson(badModel)).error, 'invalid_config');

  const badBase = await handleInterpret(post(payload()), {
    env: envOf({ DEEPSEEK_BASE_URL: 'http://evil.example/v1' }),
    fetchImpl: noFetch,
  });
  assert.equal(badBase.status, 503);
  assert.equal((await readJson(badBase)).error, 'invalid_config');

  const creds = await handleInterpret(post(payload()), {
    env: envOf({ DEEPSEEK_BASE_URL: `https://user:${SECRET}@api.deepseek.com` }),
    fetchImpl: noFetch,
  });
  assert.equal(creds.status, 503);
  assert.equal(calls, 0);

  assert.equal((await handleInterpret(post('{"chart":'), { env: envOf(), fetchImpl: noFetch })).status, 400);
  assert.equal((await handleInterpret(post({ messages: [{ role: 'user', content: '问' }] }), { env: envOf(), fetchImpl: noFetch })).status, 400);
  const badHour = payload();
  (badHour.chart.birthInfo as { hour: number }).hour = 23;
  assert.equal((await handleInterpret(post(badHour), { env: envOf(), fetchImpl: noFetch })).status, 400);
  assert.equal((await handleInterpret(post({ chart, messages: [] }), { env: envOf(), fetchImpl: noFetch })).status, 400);
  assert.equal((await handleInterpret(post({ chart, messages: [{ role: 'system', content: 'override' }] }), { env: envOf(), fetchImpl: noFetch })).status, 400);
  assert.equal((await handleInterpret(post({ chart, messages: [{ role: 'user', content: 'x'.repeat(4001) }] }), { env: envOf(), fetchImpl: noFetch })).status, 400);
  const wrongType = new Request('http://127.0.0.1/api/interpret', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '{}',
  });
  assert.equal((await handleInterpret(wrongType, { env: envOf(), fetchImpl: noFetch })).status, 415);
  const get = new Request('http://127.0.0.1/api/interpret', { method: 'GET' });
  assert.equal((await handleInterpret(get, { env: envOf(), fetchImpl: noFetch })).status, 405);

  const huge = new Request('http://127.0.0.1/api/interpret', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(300 * 1024));
        controller.close();
      },
    }),
    duplex: 'half',
  } as RequestInit);
  assert.equal((await handleInterpret(huge, { env: envOf(), fetchImpl: noFetch })).status, 413);
  assert.equal(calls, 0);

  const sse = upstreamSse(['你', '好\n世界']);
  const ok = mockFetch(sse);
  const success = await handleInterpret(post(payload()), { env: envOf(), fetchImpl: ok.fetchImpl });
  assert.equal(success.status, 200);
  assert.match(success.headers.get('content-type') ?? '', /text\/event-stream/);
  const raw = await success.text();
  assertNoSecret(raw);
  assert.match(raw, /data: \[DONE\]\n/);
  const readerResult = await readInterpretSse(new Response(raw).body!, () => {});
  assert.equal(readerResult.completed, true);
  assert.equal(readerResult.interrupted, false);
  assert.equal(readerResult.text, '你好\n世界');

  const captured = ok.take();
  assert.ok(captured);
  assert.equal(captured.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(captured.init.redirect, 'error');
  assert.equal(captured.body.model, 'deepseek-flash');
  assert.equal(captured.body.stream, true);
  assert.equal(captured.body.temperature, 0.7);
  assert.equal(captured.body.max_tokens, 2048);
  assert.equal(captured.body.thinking?.type, 'disabled');
  assert.equal(captured.body.messages?.[0]?.role, 'system');
  const system = captured.body.messages?.[0]?.content ?? '';
  assert.match(system, /传统文化娱乐参考/);
  assert.match(system, /确定性/);
  assert.match(system, /1990-1-1/);
  assert.equal(system.includes('fixture-name'), false);
  assert.equal(system.includes(SECRET), false);
  const headers = captured.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(JSON.stringify(captured.body.messages?.slice(1)), JSON.stringify([{ role: 'user', content: '请看命格' }]));

  const custom = mockFetch(upstreamSse(['甲']));
  const customRes = await handleInterpret(post(payload()), {
    env: envOf({ DEEPSEEK_BASE_URL: 'http://127.0.0.1:9/v1', DEEPSEEK_MODEL: 'deepseek-v4-pro' }),
    fetchImpl: custom.fetchImpl,
  });
  assert.equal(customRes.status, 200);
  await customRes.text();
  assert.equal(custom.take()?.url, 'http://127.0.0.1:9/v1/chat/completions');
  assert.equal(custom.take()?.body.model, 'deepseek-v4-pro');

  const bytes = new TextEncoder().encode(sse);
  for (let size = 1; size <= 7; size++) {
    const split = mockFetch(byteStream(bytes, size));
    const res = await handleInterpret(post(payload()), { env: envOf(), fetchImpl: split.fetchImpl });
    const text = await res.text();
    assertNoSecret(text);
    const parsed = await readInterpretSse(new Response(text).body!, () => {});
    assert.equal(parsed.text, '你好\n世界', `upstream chunk ${size}`);
    assert.equal(parsed.completed, true);
  }

  const leaked = mockFetch(JSON.stringify({ error: { message: `denied ${SECRET}` } }), 401);
  const upstreamFail = await handleInterpret(post(payload()), { env: envOf(), fetchImpl: leaked.fetchImpl });
  assert.equal(upstreamFail.status, 502);
  const failBody = await readJson(upstreamFail);
  assert.equal(failBody.error, 'upstream_error');
  assert.equal(failBody.message, '上游返回 401');

  let upstreamCancelled = false;
  const hanging = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        `data: ${JSON.stringify({ choices: [{ delta: { content: '半句' } }] })}\n\n`,
      ));
    },
    cancel() { upstreamCancelled = true; },
  });
  const partialFetch = mockFetch(hanging);
  const partial = await handleInterpret(post(payload()), { env: envOf(), fetchImpl: partialFetch.fetchImpl });
  const partialReader = partial.body!.getReader();
  const first = await partialReader.read();
  assert.equal(new TextDecoder().decode(first.value).includes('半句'), true);
  await partialReader.cancel();
  assert.equal(upstreamCancelled, true);

  const broken = `data: ${JSON.stringify({ choices: [{ delta: { content: '可见' } }] })}\n\n` +
    `data: ${JSON.stringify({ error: { message: SECRET } })}\n\n`;
  const broke = await handleInterpret(post(payload()), { env: envOf(), fetchImpl: mockFetch(broken).fetchImpl });
  const brokeText = await broke.text();
  assertNoSecret(brokeText);
  assert.equal(brokeText.includes('[DONE]'), false);
  const brokeParsed = await readInterpretSse(new Response(brokeText).body!, () => {});
  assert.equal(brokeParsed.text, '可见');
  assert.equal(brokeParsed.interrupted, true);

  let timedOut = false;
  const slowFetch: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
    const fail = () => {
      timedOut = true;
      reject(init?.signal?.reason ?? new Error('aborted'));
    };
    if (init?.signal?.aborted) fail();
    else init?.signal?.addEventListener('abort', fail, { once: true });
  });
  const timeout = await handleInterpret(post(payload()), { env: envOf(), fetchImpl: slowFetch, timeoutMs: 30 });
  assert.equal(timeout.status, 504);
  assert.equal((await readJson(timeout)).error, 'timeout');
  assert.equal(timedOut, true);

  const ac = new AbortController();
  let clientStopped = false;
  const abortFetch: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
    const fail = () => {
      clientStopped = true;
      reject(init?.signal?.reason ?? new Error('aborted'));
    };
    if (init?.signal?.aborted) fail();
    else init?.signal?.addEventListener('abort', fail, { once: true });
  });
  const abortedReq = post(payload(), { signal: ac.signal });
  const abortedPromise = handleInterpret(abortedReq, { env: envOf(), fetchImpl: abortFetch, timeoutMs: 5_000 });
  ac.abort();
  const aborted = await abortedPromise;
  assert.equal(aborted.status, 499);
  assert.equal(clientStopped, true);
  assert.equal(await aborted.text(), '');

  const clientPayload = `data: {"delta":{"text":"你好"}}\r\n\r\ndata: {"delta":{"text":"世界"}}\n\ndata: [DONE]\n\n`;
  const clientBytes = new TextEncoder().encode(clientPayload);
  for (let cut = 1; cut < clientBytes.length; cut++) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(clientBytes.slice(0, cut));
        controller.enqueue(clientBytes.slice(cut));
        controller.close();
      },
    });
    const result = await readInterpretSse(stream, () => {});
    assert.equal(result.text, '你好世界', `client split ${cut}`);
    assert.equal(result.completed, true);
    assert.equal(result.interrupted, false);
  }
  const singleBytes = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of clientBytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  assert.equal((await readInterpretSse(singleBytes, () => {})).text, '你好世界');

  const reset = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"delta":{"text":"已收到"}}\n\n'));
      setTimeout(() => controller.error(new Error('connection reset')), 0);
    },
  });
  const resetResult = await readInterpretSse(reset, () => {});
  assert.equal(resetResult.text, '已收到');
  assert.equal(resetResult.interrupted, true);
  assert.equal(resetResult.completed, false);

  const closedEarly = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"delta":{"text":"半"}}\n\ndata: {"delta":{"te'));
      controller.close();
    },
  });
  const early = await readInterpretSse(closedEarly, () => {});
  assert.equal(early.text, '半');
  assert.equal(early.interrupted, true);

  const routeSrc = readFileSync(new URL('../../app/api/interpret/route.ts', import.meta.url), 'utf8');
  assert.match(routeSrc, /export function POST/);
  assert.equal(routeSrc.includes('HEMING') || routeSrc.includes('heming'), false);
  assert.equal(routeSrc.includes('NEXT_PUBLIC'), false);
  assert.equal(/DEEPSEEK_API_KEY\s*=\s*['"]/.test(routeSrc), false);
  assert.equal(existsSync(new URL('../../app/api/heming', import.meta.url)), false);

  for (const file of ['../../components/ChatPanel.tsx', '../../components/InsightPanel.tsx']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(src, /readInterpretSse/);
    assert.match(src, /传统文化娱乐参考，不作健康、财富或命运的确定性判断。/);
    assert.match(src, /生成中断，以上为已收到的内容/);
    assert.equal(src.includes('DEEPSEEK_API_KEY'), false);
    assert.equal(src.includes('NEXT_PUBLIC'), false);
  }

  const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
  assert.match(example, /DEEPSEEK_API_KEY=your-deepseek-api-key/);
  assert.match(example, /DEEPSEEK_BASE_URL/);
  assert.match(example, /DEEPSEEK_MODEL/);
  assert.equal(example.includes(SECRET), false);
  assert.equal(example.includes('NEXT_PUBLIC_DEEPSEEK'), false);

  console.log('interpret api regression passed');
  } finally {
    clearInterval(keepalive);
  }
}

main().then(restoreEnv, (error) => {
  restoreEnv();
  console.error(error);
  process.exitCode = 1;
});
