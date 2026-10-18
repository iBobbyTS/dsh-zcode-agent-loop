/**
 * 验收事实登记表：单一事实源。
 * 这里只登记已有人工确认的证据、显式 open 与缺环境未验收项；生成器不得由
 * 覆盖数推导"全部接入"。矩阵差分、能力清单与任务状态分别呈现。
 */
export type AcceptanceStatus = 'covered' | 'open' | 'unverified';
export type TaskStatus = 'accepted' | 'partial' | 'open';
export type EvidenceKind = 'command' | 'browser' | 'scenario';

export interface EvidenceRef {
 kind: EvidenceKind;
 /** command 为 package.json 脚本名；browser 为仓库相对路径；scenario 为 twin 场景 id。 */
 ref: string;
 note?: string;
}

export interface AcceptanceItem {
 id: string;
 requirement: string;
 status: AcceptanceStatus;
 evidence: EvidenceRef[];
 /** 该要求归属的任务；用于把任务状态与验收族事实交叉展示。 */
 task: string;
 /** open/unverified 必须写明原因；covered 可写边界说明。 */
 reason?: string;
}

export interface AcceptanceFamily {
 id: string;
 title: string;
 items: AcceptanceItem[];
}

export interface TaskRecord {
 id: string;
 title: string;
 status: TaskStatus;
 evidence: EvidenceRef[];
 remaining?: string[];
}

export const requiredFamilies = [
 { id: 'loop-reliability', title: '循环可靠性' },
 { id: 'request-plugin', title: '请求和插件' },
 { id: 'history-compaction', title: '历史和压缩' },
 { id: 'lifecycle', title: '生命周期' },
 { id: 'dsh-user-features', title: 'dsh 用户功能' },
 { id: 'new-plugins', title: '新插件' },
 { id: 'deployment-upgrade', title: '部署与升级' },
] as const;

const browser = (file: string): EvidenceRef => ({ kind: 'browser', ref: `.agent-work/evidence/integration/${file}` });
const command = (script: string): EvidenceRef => ({ kind: 'command', ref: script });
const scenario = (id: string): EvidenceRef => ({ kind: 'scenario', ref: id });

export const acceptanceFamilies: AcceptanceFamily[] = [
 {
  id: 'loop-reliability',
  title: '循环可靠性',
  items: [
   { id: 'multi-step-tool-round-trip', requirement: '多步工具往返、工具结果回到模型、并行/独占工具执行', status: 'covered', task: 'T08', evidence: [scenario('tool-round-trip'), command('verify:tool-pathway'), browser('browser-tool-pathway.txt')] },
   { id: 'output-limit-continuation', requirement: '输出上限后的引擎续写', status: 'covered', task: 'T05', evidence: [command('verify:step-boundary')], reason: 'step-boundary 的 engine-output-continuation 用例断言 max-tokens 后续写。' },
   { id: 'stream-disconnect-recovery', requirement: '流断开/部分流恢复，且失败尝试不重复工具副作用', status: 'covered', task: 'T05', evidence: [command('verify:step-boundary'), command('verify:crash-recovery')] },
   { id: 'model-failure-plugin-retry', requirement: '模型失败进入插件重试边界，不重复准入或工具执行', status: 'covered', task: 'T02', evidence: [command('verify:step-boundary'), command('verify:history-compaction')] },
   { id: 'cancel-preserves-visible-prefix', requirement: '取消保留已显示文本并写入 aborted 终态', status: 'covered', task: 'T05', evidence: [scenario('cancel-mid-stream'), command('verify:step-boundary'), browser('browser-cancel.txt')] },
   { id: 'unknown-side-effect-not-replayed', requirement: '崩溃后未知副作用不自动重做', status: 'covered', task: 'T05', evidence: [command('verify:crash-recovery'), browser('browser-cold-resume.txt')] },
   { id: 'real-provider-anomaly', requirement: '真实 provider 网络断开、异常流与模型错误', status: 'unverified', task: 'T05', evidence: [], reason: '缺少外部真实 provider 环境；当前仅受控 adapter 的行为规格与故障注入。' },
  ],
 },
 {
  id: 'request-plugin',
  title: '请求和插件',
  items: [
   { id: 'per-step-admission-reject-rewrite', requirement: '第 2 步准入/拒绝/改写；取消不提交消息', status: 'covered', task: 'T02', evidence: [command('verify:step-boundary')] },
   { id: 'prompt-plan-change-clear', requirement: 'prompt/plan 变更与清空在下一步生效', status: 'covered', task: 'T03', evidence: [command('verify:step-boundary'), command('verify:goal-plan')] },
   { id: 'route-model-budget', requirement: 'adapter 切换、模型/档位、maxTokens 与 dsh options 对齐', status: 'covered', task: 'T07', evidence: [command('verify:model-config'), browser('browser-model-config.txt')] },
   { id: 'scope-initiator-hot-tools', requirement: 'scope/initiator、工具热增删与每步可见性', status: 'covered', task: 'T08', evidence: [command('verify:preset-tools'), command('verify:tool-surface-context')] },
   { id: 'request-header-context-toolhistory', requirement: '实际请求的 header/context/toolHistory 与 durable 记录一致', status: 'covered', task: 'T02', evidence: [command('verify:request-provenance')], reason: 'header/context 对齐与 resume 重放由真实 adapter dispatch 断言；toolHistory 按 dsh 实际字段记录。' },
   { id: 'plugin-contributed-surface', requirement: '插件贡献 prompt/tools/context，skill/MCP/引用进入下一请求', status: 'covered', task: 'T09', evidence: [command('verify:extension-foundation'), browser('browser-extension-foundation.txt')] },
   { id: 'credential-refresh', requirement: 'provider 凭证刷新', status: 'unverified', task: 'T07', evidence: [], reason: '缺少真实 provider 账户与刷新端点；T22 只验证凭证文件在启停/重载中不被改写。' },
  ],
 },
 {
  id: 'history-compaction',
  title: '历史和压缩',
  items: [
   { id: 'auto-manual-overflow-compaction', requirement: '自动、手动、overflow 与轮间压缩使用 dsh 有效 surface', status: 'covered', task: 'T04', evidence: [command('verify:history-compaction'), browser('browser-compaction.txt')] },
   { id: 'surface-strict-durable-recovery', requirement: '严格落盘重读、resume/fork 与原有效 surface 一致', status: 'covered', task: 'T04', evidence: [command('verify:crash-recovery'), command('verify:branch-rerun'), browser('browser-cold-resume.txt')] },
   { id: 'goal-scheduler-context-sources', requirement: 'goal/scheduler/context 来源进入有效历史', status: 'covered', task: 'T04', evidence: [command('verify:goal-chain'), command('verify:jobs-schedule')] },
   { id: 'pruner-image-offload', requirement: 'pruner 与图片 offload 组合', status: 'open', task: 'T04', evidence: [], reason: '已知未验收：图片事实通路已由 T14 覆盖，但与 pruner/offload 的组合仍未形成场景。' },
  ],
 },
 {
  id: 'lifecycle',
  title: '生命周期',
  items: [
   { id: 'queue-edit-pause-resume', requirement: 'pending 队列编辑/暂停/恢复，next-turn 顺序一致', status: 'covered', task: 'T06', evidence: [scenario('queued-followup'), command('verify:agent-lifecycle'), browser('browser-queue-A.txt')] },
   { id: 'steer-idle-maintenance-race', requirement: 'steer 与 idle/maintenance 竞态', status: 'covered', task: 'T06', evidence: [command('verify:agent-lifecycle')] },
   { id: 'setup-dispose-reload', requirement: 'setup 失败回滚、卸载/HMR、重复 dispose 与同 ID 重建', status: 'covered', task: 'T06', evidence: [command('verify:agent-lifecycle'), command('verify:deployment-settings')] },
   { id: 'flush-crash-boundary', requirement: '请求/工具前 flush 失败与崩溃不产生悬挂 turn', status: 'covered', task: 'T05', evidence: [command('verify:crash-recovery'), command('verify:step-boundary')] },
  ],
 },
 {
  id: 'dsh-user-features',
  title: 'dsh 用户功能',
  items: [
   { id: 'goal-todo-plan', requirement: 'goal 续轮/预算/中止恢复、todo 与 plan 状态', status: 'covered', task: 'T10', evidence: [scenario('goal-round'), command('verify:goal-chain'), command('verify:goal-plan'), browser('browser-goal-plan.txt')] },
   { id: 'tool-pipeline', requirement: '工具经 dsh tools.execute/权限/超时/spill 管线执行', status: 'covered', task: 'T08', evidence: [scenario('tool-round-trip'), command('verify:tool-pathway'), browser('browser-tool-pathway.txt')] },
   { id: 'dsh-builtin-tool-plugins', requirement: 'fs/bash/web/ask-user 等宿主内建工具插件逐项启用', status: 'unverified', task: 'T08', evidence: [], reason: '验收容器只证明工具管线与受控工具；宿主内建插件组合缺少环境，不能由管线正确性推导各自可用。' },
   { id: 'skill-mcp-reference', requirement: 'skill/MCP/resource 与 file/session 引用进入模型上下文并可回溯', status: 'covered', task: 'T09', evidence: [command('verify:extension-foundation'), command('verify:references-diagnostics'), browser('browser-references-diagnostics.txt')] },
   { id: 'subagent-sidechat', requirement: 'subagent spawn/fork/control/续聊与选区 side chat', status: 'covered', task: 'T11', evidence: [command('verify:subagent-sidechat'), browser('browser-sidechat.txt')] },
   { id: 'workflow', requirement: 'workflow 扇出、进度、失败/取消收口与可继续子会话', status: 'covered', task: 'T12', evidence: [command('verify:workflow'), browser('browser-workflow.txt')], reason: '原生 DSL 的 run 修订/hole/escalation 未接入，见 open 项。' },
   { id: 'workflow-native-protocol', requirement: 'ZCode 原生 dynamic-workflow run 修订/持久恢复/hole/escalation', status: 'open', task: 'T12', evidence: [], reason: '明确不接入的原生协议；dsh workflow 不声称等价。' },
   { id: 'jobs-schedule-offpeak', requirement: 'jobs/schedule/off-peak 创建、列举、取消、重启触发与 source 回投', status: 'covered', task: 'T13', evidence: [command('verify:jobs-schedule'), browser('browser-offpeak.txt')], reason: 'jobs-local 进程内作业按源码不跨重启；schedule 的跨宿主恢复已断言。' },
   { id: 'attachments-media', requirement: '图片 inbox→有效历史→adapter→恢复/fork/工具结果', status: 'covered', task: 'T14', evidence: [command('verify:attachments-media'), browser('browser-attachments-media.txt')] },
   { id: 'native-media-blocks', requirement: 'PDF/音视频原生 provider 输入', status: 'open', task: 'T14', evidence: [], reason: '明确不支持的原生媒体块；不做转换假装支持。' },
   { id: 'title-rename', requirement: '宿主 title/rename 入口与会话生命周期', status: 'unverified', task: 'T22', evidence: [], reason: '依赖宿主既有功能，当前没有针对本插件的消费者场景。' },
  ],
 },
 {
  id: 'new-plugins',
  title: '新插件',
  items: [
   { id: 'branch-rerun', requirement: '从已完成边界派生分支、编辑输入重跑，父 log 不被截断', status: 'covered', task: 'T16', evidence: [command('verify:branch-rerun'), browser('browser-branch-rerun.txt')] },
   { id: 'file-checkpoints', requirement: '写前快照、list/preview/apply、预检冲突与重启', status: 'covered', task: 'T17', evidence: [command('verify:file-checkpoints'), browser('browser-file-checkpoints.txt')], reason: '仅捕获显式 dsh 写工具；shell/外部程序变更明确不可恢复。' },
   { id: 'project-memory', requirement: '有界提取、下一请求召回、跨项目隔离与重启', status: 'covered', task: 'T18', evidence: [command('verify:project-memory'), browser('browser-project-memory.txt')], reason: '不复制 ZCode 原生 extraction/dream 算法。' },
   { id: 'workspace-hooks', requirement: '生命周期/工具/请求/取消 hooks 的 block 与日志', status: 'covered', task: 'T19', evidence: [command('verify:workspace-hooks')], reason: 'updatedInput 与 Stop block 为已记录边界；未知 hook 类型显式拒绝。' },
   { id: 'offpeak-policy', requirement: '本地低峰调度策略与云端协议分离', status: 'covered', task: 'T13', evidence: [command('verify:jobs-schedule'), browser('browser-offpeak.txt')], reason: '只表达本地时段策略，不承诺云端优惠权益。' },
   { id: 'persistent-js', requirement: '持久 JS 工具跨调用持久、跨会话隔离、取消清理', status: 'covered', task: 'T20', evidence: [command('verify:browser-cua-repl'), browser('browser-persistent-js.txt')] },
   { id: 'real-browser-cua-provider', requirement: '真实浏览器与 CUA provider 的读取/操作', status: 'unverified', task: 'T20', evidence: [], reason: '验收容器无 Chrome/CUA provider；CI 只证明注册面与 mock provider 通路。' },
   { id: 'native-browser-cua-protocol', requirement: 'ZCode 浏览器注入对象与 CUA 原生协议', status: 'open', task: 'T20', evidence: [], reason: '明确不承诺兼容全部原生对象/API。' },
  ],
 },
 {
  id: 'deployment-upgrade',
  title: '部署与升级',
  items: [
   { id: 'headless-web-sdk-forms', requirement: 'headless/web/SDK-minimal 形态装配并跑代表性任务', status: 'covered', task: 'T22', evidence: [command('verify:deployment-settings'), browser('browser-deployment-settings.txt')] },
   { id: 'in-process-subagent-factory', requirement: '进程内子 agent 使用同一个 loop factory', status: 'covered', task: 'T22', evidence: [command('verify:subagent-sidechat'), command('verify:workflow')] },
   { id: 'loader-config-registration', requirement: '实际 loader 配置与运行注册一致；插件卸载/重载可用', status: 'covered', task: 'T22', evidence: [command('verify:deployment-settings'), command('cold-start'), command('verify:facade')] },
   { id: 'credentials-preserved', requirement: '用户凭证与旁路配置在生命周期中保持不变', status: 'covered', task: 'T22', evidence: [command('verify:deployment-settings')] },
   { id: 'old-session-resume', requirement: '旧 session 可读可续且不重放未知副作用', status: 'covered', task: 'T05', evidence: [command('verify:crash-recovery'), command('verify:history-compaction')] },
   { id: 'alternate-snapshot-drill', requirement: '换一份不同 ZCode 快照并运行门禁', status: 'open', task: 'T24', evidence: [], reason: '没有可获得且已固定的候选快照；演练未完成，不能以修改版本号替代。' },
   { id: 'drift-snapshot-finalization', requirement: 'T01 生成快照/清单的最终候选与文档检查', status: 'open', task: 'T01', evidence: [command('verify:capabilities')], reason: 'T01 仍在实施中；既有快照机制维持，但最终候选未关闭。' },
  ],
 },
];

const accepted = (evidence: EvidenceRef[]): Pick<TaskRecord, 'status' | 'evidence'> => ({ status: 'accepted', evidence });

export const taskRecords: TaskRecord[] = [
 { id: 'T01', title: '清单改为生成结果', status: 'partial', evidence: [command('verify:capabilities'), command('verify:capabilities:selftest')], remaining: ['最终候选与文档检查'] },
 { id: 'T02', title: '每步请求接缝', ...accepted([command('verify:step-boundary')]) },
 { id: 'T03', title: '动态提示与运行时上下文', ...accepted([command('verify:step-boundary'), command('verify:goal-plan')]) },
 { id: 'T04', title: '统一有效历史及压缩', status: 'partial', evidence: [command('verify:history-compaction'), command('verify:crash-recovery')], remaining: ['图片 offload/pruner 组合'] },
 { id: 'T05', title: '错误、取消与持久性', ...accepted([command('verify:step-boundary'), command('verify:crash-recovery')]) },
 { id: 'T06', title: '队列、维护及资源生命周期', ...accepted([command('verify:agent-lifecycle')]) },
 { id: 'T07', title: '模型与必要配置', ...accepted([command('verify:model-config')]) },
 { id: 'T08', title: '工具完整通路', ...accepted([command('verify:tool-pathway'), command('verify:preset-tools')]) },
 { id: 'T09', title: 'dsh 扩展基础', ...accepted([command('verify:extension-foundation')]) },
 { id: 'T10', title: 'goal/todo/plan', ...accepted([command('verify:goal-plan'), command('verify:goal-chain')]) },
 { id: 'T11', title: 'subagent 与侧聊', ...accepted([command('verify:subagent-sidechat')]) },
 { id: 'T12', title: 'workflow', ...accepted([command('verify:workflow')]) },
 { id: 'T13', title: 'jobs/schedule/off-peak', ...accepted([command('verify:jobs-schedule')]) },
 { id: 'T14', title: '附件与媒体', ...accepted([command('verify:attachments-media')]) },
 { id: 'T15', title: '插件的窄接缝', ...accepted([command('verify:runtime-seam')]) },
 { id: 'T16', title: '回退／编辑重跑入口', ...accepted([command('verify:branch-rerun')]) },
 { id: 'T17', title: '文件检查点与回滚插件', ...accepted([command('verify:file-checkpoints')]) },
 { id: 'T18', title: '项目记忆插件', ...accepted([command('verify:project-memory')]) },
 { id: 'T19', title: 'workspace hooks', ...accepted([command('verify:workspace-hooks')]) },
 { id: 'T20', title: '浏览器/CUA/持久 JS', ...accepted([command('verify:browser-cua-repl')]) },
 { id: 'T21', title: '上下文引用、产物与诊断', ...accepted([command('verify:references-diagnostics')]) },
 { id: 'T22', title: '部署与设置', ...accepted([command('verify:deployment-settings')]) },
 { id: 'T23', title: '验收与状态生成', status: 'partial', evidence: [command('verify:acceptance')], remaining: ['父级复核与验收记录'] },
 { id: 'T24', title: '升级工具与演练', status: 'open', evidence: [], remaining: ['无候选快照；实际升级演练未完成'] },
];

export const acceptanceBoundaries = [
 '共享 twin fixture 只装配 llm/session/system-prompt/tools/session-projection/goal/goal-round-driver/tool-todo/tool-goal/agent，不等同完整 web profile activation。',
 '受控 adapter 只证明本仓库桥接与 dsh 消费方契约，不证明真实模型质量、provider 连通性或网络异常。',
 '原生协议不接项（PluginUi、desktop telemetry、remote session/前台租约、CUA 原生、workflow DSL run 修订/hole）保持显式 open。',
 '验收族状态只汇总登记的事实；覆盖项数量不能推导"全部接入"，最终交付仍需独立验收记录。',
];
