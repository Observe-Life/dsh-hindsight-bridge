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

function requireQuery(args) {
  const query = typeof args?.query === 'string' ? args.query.trim() : '';
  return query || null;
}

export function buildToolDefinitions({ snapshot, clientFor, statsOf }) {
  return [
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
