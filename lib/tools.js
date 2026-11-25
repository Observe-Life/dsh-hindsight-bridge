/**
 * Model-facing memory tools — the "agent can query the bank itself" half of the bridge.
 *
 * The auto pipeline (pre-step recall, turn-end retention) covers the passive path; these
 * definitions are what the model calls when it wants to look something up on demand, the way
 * hindsight-coding-agents registers its tool suite natively on `ctx.tools`. Definitions are plain
 * objects in dsh's registry shape (name / description / parameters / output / execute) so this
 * module stays free of any `@deepseek-ai/dsh-tools` dependency, and every `execute` resolves the
 * config snapshot at call time — a live settings edit changes tool behaviour on the next call
 * without a reload, exactly like the hooks.
 *
 * Error contract: a tool body never throws for an expected failure (unreachable server, disabled
 * config, empty query). dsh renders a thrown body as a tool error; text results keep the model in
 * control and let it answer without the memory. Stats always move through the same runtime object
 * the auto pipeline reports, so `hindsight_status` and the settings panel show one truth.
 */

import {cleanText} from './memory.js';

const EMPTY_NOTE = '记忆库中没有与该问题直接相关的记忆。';

/** Render recall results as a bullet list, capped at maxMemories; null when nothing survived.
 * Each line passes the same redaction as the auto-recall injection block — one source, one policy. */
function listText(results, maxMemories, redact) {
  const lines = (Array.isArray(results) ? results : [])
    .slice(0, maxMemories)
    .map(item => (typeof item?.text === 'string' ? cleanText(item.text, redact) : ''))
    .filter(Boolean)
    .map(text => '- ' + text.replace(/\r?\n/g, '\n  '));
  return lines.length ? lines.join('\n') : null;
}

/** Split a comma/Chinese-comma/semicolon separated tag string into clean tags. */
function parseTags(raw) {
  if (typeof raw !== 'string') return [];
  return raw.split(/[,，、;；]+/).map(tag => tag.trim()).filter(Boolean).slice(0, 16);
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('Aborted'), { code: 'ABORTED' }));
    if (signal?.aborted) { abort(); return; }
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(); };
    const onAbort = () => { clearTimeout(timer); abort(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * One model-initiated retain, mirroring the Hermes provider's `hindsight_retain` tool:
 * async submit, immediate "queued" reply, and a background poll that moves the runtime
 * counters (accepted → completed/failed) so `hindsight_status` reports one truth. Never
 * throws for an expected failure — the tool result text carries it back to the model.
 */
async function executeRetain({ config, runtime, clientFor, args, signal }) {
  if (!config?.enabled) return 'Hindsight 记忆已停用（enabled=false），无法写入。';
  const content = typeof args?.content === 'string' ? args.content.trim() : '';
  if (!content) return 'content 不能为空：把要长期记住的事实写成一段话。';
  const occurredAt = typeof args?.occurred_at === 'string' ? args.occurred_at.trim() : '';
  if (occurredAt && Number.isNaN(Date.parse(occurredAt))) {
    return "occurred_at 需要是 ISO-8601 日期或日期时间（如 '2026-08-20' 或 '2026-08-20T14:30:00+02:00'）；不确定时间就省略它。";
  }
  const clean = cleanText(content, config.redactSecrets !== false).slice(0, config.maxRetainChars ?? 16000);
  if (!clean) return 'content 脱敏后为空，没有提交任何内容。';
  const tags = [...(config.retainTags ?? []), ...parseTags(args?.tags)];
  const item = {
    content: clean,
    timestamp: occurredAt || new Date().toISOString(),
  };
  if (typeof args?.context === 'string' && args.context.trim()) {
    item.context = cleanText(args.context, config.redactSecrets !== false).trim().slice(0, 200);
  }
  if (tags.length) item.tags = tags;
  if (runtime.pending instanceof Map && runtime.pending.size >= (config.maxPendingWrites ?? 32)) {
    runtime.stats.dropped++;
    return '写入队列已满（可能有大量提取尚未完成），这条没有提交，请稍后重试。';
  }
  const id = 'tool-' + Math.random().toString(36).slice(2) + '-' + Date.now();
  // Submit is awaited (Hermes's tool path does the same): a submit failure must surface to
  // the model as tool text, not as a fake "queued". Only the extraction poll is backgrounded.
  let response;
  try {
    response = await clientFor(config, config.retainTimeoutMs).retain({ items: [item], async: true });
  } catch (error) {
    runtime.stats.failed++;
    return `Hindsight 写入失败（${error?.code ?? 'NETWORK'}），记忆服务可能不可达。`;
  }
  if (response?.success !== true) {
    runtime.stats.failed++;
    return 'Hindsight 写入失败（RETAIN_REJECTED），记忆服务拒绝了这次提交。';
  }
  const operationIds = [...new Set([response.operation_id, ...(Array.isArray(response.operation_ids) ? response.operation_ids : [])]
    .filter(x => typeof x === 'string' && x))];
  if (response.async !== false && operationIds.length === 0) {
    runtime.stats.failed++;
    return 'Hindsight 写入失败（INVALID_RESPONSE），记忆服务没有返回提取任务标识。';
  }
  runtime.stats.accepted++;
  if (!operationIds.length) {
    // sync acceptance without an operation: already stored server-side
    runtime.stats.completed++;
    return '已写入记忆库。';
  }
  const pollPromise = (async () => {
    const deadline = AbortSignal.timeout(config.operationTimeoutMs ?? 120000);
    const signalAny = signal ? AbortSignal.any([signal, deadline]) : deadline;
    for (const operationId of operationIds) {
      for (;;) {
        const op = await clientFor(config, config.retainTimeoutMs).operation(operationId, { signal: signalAny });
        if (op.status === 'completed') break;
        if (['failed', 'cancelled'].includes(op.status)) {
          throw Object.assign(new Error('Operation failed'), { code: 'OPERATION_FAILED' });
        }
        if (signalAny.aborted) throw Object.assign(new Error('Aborted'), { code: 'ABORTED' });
        await delay(config.operationPollMs ?? 500, signalAny);
      }
    }
    runtime.stats.completed++;
  })().catch(error => {
    runtime.stats.failed++;
  }).finally(() => runtime.pending.delete(id));
  runtime.pending.set(id, { session: null, promise: pollPromise });
  return '已排队入库（异步提取通常约 20 秒内完成，之后可被 hindsight_recall 检索）。';
}

function requireQuery(args) {
  const query = typeof args?.query === 'string' ? args.query.trim() : '';
  return query || null;
}

export function buildToolDefinitions({ snapshot, clientFor, statsOf, lifecycleSignal }) {
  return [
    {
      name: 'hindsight_retain',
      description:
        '把一条要长期记住的事实写入 Hindsight 记忆库（Hindsight 自动提取结构化事实、归一实体并建立检索索引）。' +
        '适合记住明确的偏好、决定、约定或教训——日常对话的普通内容不需要你手动写，回答结束会自动留存。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '要存入记忆的信息本体，一段完整的话。' },
          context: { type: 'string', description: '一句话说明这条记忆是什么（如「用户偏好」「项目决定」）。' },
          tags: { type: 'string', description: '可选：附加标签，逗号分隔（如「健康,保险」），会与默认标签合并。' },
          occurred_at: {
            type: 'string',
            description: ("可选：事件实际发生的时间，ISO-8601 日期或日期时间（如 '2026-08-20'）。记忆里提到具体时间时才传，省略表示与时间无关。"),
          },
        },
        required: ['content'],
        additionalProperties: false,
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args) {
        const config = snapshot();
        return executeRetain({ config, runtime: statsOf(), clientFor, args, signal: lifecycleSignal?.() });
      },
    },
    {
      name: 'hindsight_recall',
      description:
        '检索 Hindsight 长期记忆库：按语义查找跨会话留存的事实、偏好与约定，返回按相关度排序的记忆列表。' +
        '当自动召回没带出你需要的历史，或回答前想核实某个既定事实时使用。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '用一句自然语言描述要找的记忆，中英文皆可。' } },
        required: ['query'],
        additionalProperties: false,
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args) {
        const config = snapshot();
        if (!config?.enabled) return 'Hindsight 记忆已停用（enabled=false），无法检索。';
        const query = requireQuery(args);
        if (!query) return 'query 不能为空：用一句自然语言描述要找的记忆。';
        const runtime = statsOf();
        try {
          const response = await clientFor(config, config.recallTimeoutMs)
            .recall({ query, budget: config.recallBudget, types: config.recallTypes, max_tokens: config.recallMaxTokens });
          runtime.stats.recalls++;
          const text = listText(response?.results, config.maxMemories, config.redactSecrets !== false);
          return text ?? EMPTY_NOTE;
        } catch (error) {
          runtime.stats.recallFailed++;
          return `Hindsight 检索失败（${error?.code ?? 'NETWORK'}），记忆服务可能不可达。`;
        }
      },
    },
    {
      name: 'hindsight_reflect',
      description:
        '跨记忆归纳：让 Hindsight 综合整个记忆库回答一个问题（如「总结用户的服务器约定」），' +
        '适合检索式查询拼不出结论的场合。注意：这是真实的大模型推理，常见耗时十几秒到几十秒，仅在确实需要综合结论时使用。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '要用全部记忆综合回答的问题。' } },
        required: ['query'],
        additionalProperties: false,
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args) {
        const config = snapshot();
        if (!config?.enabled) return 'Hindsight 记忆已停用（enabled=false），无法归纳。';
        const query = requireQuery(args);
        if (!query) return 'query 不能为空：写出要综合回答的问题。';
        const runtime = statsOf();
        try {
          const response = await clientFor(config, config.recallTimeoutMs)
            .reflect({ query, max_tokens: config.recallMaxTokens });
          const text = typeof response?.text === 'string' ? response.text.trim() : '';
          return text || '记忆库中没有足以支撑综合回答的内容。';
        } catch (error) {
          return `Hindsight 归纳失败（${error?.code ?? 'NETWORK'}），记忆服务可能不可达或本次超时。`;
        }
      },
    },
    {
      name: 'hindsight_status',
      description: '查看 Hindsight 记忆插件的当前配置与读写统计（从不包含任何密钥）。',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() {
        const config = snapshot();
        const runtime = statsOf();
        const lines = [
          `启用: ${Boolean(config?.enabled)}（自动召回 ${Boolean(config?.autoRecall)} / 自动写入 ${Boolean(config?.autoRetain)}）`,
          `服务地址: ${config?.apiUrl ?? '(未配置)'}`,
          `记忆库: ${config?.bankId ?? '(未配置)'}（召回预算 ${config?.recallBudget ?? '-'}，类型 ${(config?.recallTypes ?? []).join(',') || '-'}）`,
        ];
        if (runtime?.stats) {
          const { recalls=0, recallFailed=0, accepted=0, completed=0, failed=0, dropped=0 } = runtime.stats;
          lines.push(`工具与自动召回: 本会话召回 ${recalls} 次（失败 ${recallFailed}）`);
          lines.push(`写入: 已接受 ${accepted} / 完成 ${completed} / 失败 ${failed} / 队列丢弃 ${dropped}` +
            (runtime.pending instanceof Map ? ` / 进行中 ${runtime.pending.size}` : ''));
        } else {
          lines.push('统计: 运行时未初始化');
        }
        return lines.join('\n');
      },
    },
  ];
}
