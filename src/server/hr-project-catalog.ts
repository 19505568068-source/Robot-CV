export type HrWebProjectCard = {
  id: string;
  title: string;
  category: string;
  summary: string;
  dateLabel?: string;
  statusLabel?: string;
};

export type HrWebProjectDetail = HrWebProjectCard & {
  role: string;
  problem: string;
  work: string;
  method: string;
  result: string;
};

/**
 * Publicly shareable experience index. Keep this separate from opportunities
 * and local knowledge paths so the visitor endpoint can expose only curated,
 * resume-grounded facts.
 */
export const HR_WEB_PROJECTS: readonly HrWebProjectDetail[] = [
  {
    id: "hr-clawbot",
    title: "微信扫码 HR ClawBot 招聘沟通助手",
    category: "个人项目 · 项目资料",
    summary: "把简历、知识问答和招聘对话整理成可审核的移动端流程。",
    dateLabel: "2026.09",
    statusLabel: "二次开发与部署验证",
    role: "需求设计、开源框架二次开发、测试与本机/局域网部署验证",
    problem: "招聘沟通需要同时处理访客授权、简历交付、知识问答、聊天归档和机会判断，并保留人工确认边界。",
    work: "拆分管理端与访客端，接入简历和资料解析；实现授权后介绍与原始简历交付、消息先归档再异步调用 Codex、独立会话线程和机会证据留存。",
    method: "用队列控制同一访客的消息顺序，以结构化字段记录公司、岗位、条件、关注点和邀约信号，再用类型校验、CSRF、限流和人工审核限制自动化边界。",
    result: "项目资料记录 311 项自动化测试（309 通过、0 失败、2 项因平台条件跳过），类型检查通过；当前口径仍是本机/局域网二次开发与部署验证，原始简历保持不被覆盖。"
  },
  {
    id: "red-infinity",
    title: "Red Infinity 游戏策划实习",
    category: "实习经历",
    summary: "用海外玩家 A/B 实验迭代关卡体验与广告素材。",
    dateLabel: "2026.05—2026.08",
    role: "游戏策划",
    problem: "需要验证海外安卓玩家对 ASMR 视听反馈、关卡难度和广告素材的响应，并找到可量化的迭代方向。",
    work: "覆盖约 1.2 万海外安卓玩家开展 A/B 实验，参与 24 关 ASMR 视听反馈与难度优化，协同客户端、服务端、美术和音频推动 3 个实验版本上线。",
    method: "按实验版本对比单局时长、留存、续关、广告展示、素材 CTR 等指标，再据数据迭代关卡与素材。",
    result: "单局时长提升 8.7%、次日留存提升 2.1%、续关率提升 6.2%、激励广告展示提升 7.4%、广告 ARPU 提升 5.8%、素材 CTR 提升 10.6%、CPI 下降 7.9%、D7 ROAS 提升 6.8%。"
  },
  {
    id: "linchang-fde-service",
    title: "北京霖畅生物科技有限公司 FDE 服务",
    category: "FDE 经历",
    summary: "参与企业内部孵化项目，从 0 到 1 梳理产品与检索采购流程。",
    dateLabel: "2025.07—至今",
    statusLabel: "进行中",
    role: "FDE（企业内部孵化创业项目）",
    problem: "需要把产品建设、检索采购和客户验证流程拆成可执行、可衡量的产品工作。",
    work: "参与用户访谈、竞品分析、需求拆解、信息架构和原生交互原型，协同研发上线；沉淀 3 万+ 产品规格数据并对接 13 家意向合作企业开展 A/B 验证。",
    method: "用访谈和竞品分析定位需求，以原型和 A/B 验证形成闭环，并对规格数据和检索采购流程设置质量校验。",
    result: "资料记录的阶段结果为检索/采购流程效率约提升 70%、产品规格数据准确率 99.8%；具体口径可在交流中进一步说明。"
  },
  {
    id: "dawan-delivery",
    title: "广东大亚湾保护区调整方案智能交付",
    category: "生态空间规划 · 项目经历",
    summary: "把法规、GIS 处理和方案验收串成可复核的智能交付流程。",
    dateLabel: "2025.11—2026.04",
    statusLabel: "资料口径待确认",
    role: "策划分析",
    problem: "面向拟建码头与自然保护区的空间冲突，需要同时处理法规解析、数据处理、方案生成、生态评估和成果交付。",
    work: "负责需求拆解、产品方案和项目计划，规划从法规解析到成果交付的链路；搭建 AI Agent 辅助 GIS 工作流，形成 Prompt、Python 脚本、GIS 执行与校验的闭环。",
    method: "用 WBS 组织生态、GIS、项目管理和报批需求，并设置面积误差、空间重叠、连通性、几何有效性和码头覆盖率等自动验收规则。",
    result: "设计 6 套保护区调整方案，建立面积误差、空间重叠度、连通性、几何有效性和码头覆盖率等量化指标，并形成生成—执行—校验—纠错闭环与 SOP/Loop 提示词。"
  },
  {
    id: "hulin-changchun",
    title: "虎林—长春天然气管道生态影响评估",
    category: "生态影响评价",
    summary: "将沿线调查、遥感、微生物测序和报告修订串成可复核的分析链路。",
    dateLabel: "2024—2026",
    statusLabel: "阶段成果",
    role: "管道沿线生态调查与评估负责人",
    problem: "需要评估管道建设对生物多样性、栖息地、土壤健康和碳汇功能的影响，并把空间调查与样本分析连接起来。",
    work: "设计并实施沿线生态调查，整合 ArcGIS 与 Google Earth Engine 遥感数据；围绕 9 个土壤剖面和 3 个深度层构建 27 个样本矩阵，完成约 287 万条 16S 序列质控。",
    method: "使用 R 4.5.1、vegan、ggplot2 和 pheatmap 开展 α 多样性、稀释曲线、聚类与 CCA；Codex 只辅助指标和报告结构检查，关键结论回到原始数据与技术要求复核。",
    result: "形成环境影响报告及论文修回稿，并识别土壤容重、总碳等关键环境因子。"
  },
  {
    id: "fish-occurrence-database",
    title: "全国流域鱼类出现数据库",
    category: "生态数据工程 · 项目资料",
    summary: "把全国流域文献和调查记录整理为可检索、可统计的时空分布矩阵。",
    dateLabel: "文献范围 2000—2024",
    role: "数据库字段设计、文献数据提取与质量控制",
    problem: "文献中的表格、图片、坐标和物种名称口径不一，需要建立可追溯的字段体系和异常处理规则。",
    work: "设计采样点、物种、流域、文献来源、采样方法和经纬度等标准化字段，搭建轻量提取应用并记录坐标缺失、点位与物种名录不匹配等异常。",
    method: "使用 Google AI Studio 辅助结构化提取，再通过提示词迭代、抽样校验和原文回溯修正控制提取误差，保留人工复核和来源追踪。",
    result: "最新版本覆盖 122 篇文献、2,206 条样点记录、1,924 条有效坐标，582 个鱼类条目存在实际出现记录。"
  }
] as const;

export function getHrWebProject(projectId: string): HrWebProjectDetail | undefined {
  return HR_WEB_PROJECTS.find((project) => project.id === projectId);
}

export function listHrWebProjectCards(): HrWebProjectCard[] {
  return HR_WEB_PROJECTS.map(({ id, title, category, summary, dateLabel, statusLabel }) => ({
    id,
    title,
    category,
    summary,
    ...(dateLabel ? { dateLabel } : {}),
    ...(statusLabel ? { statusLabel } : {})
  }));
}

export function formatHrWebProjectDetail(project: HrWebProjectDetail): string {
  return [
    `【${project.title}】`,
    ...(project.dateLabel ? [`时间：${project.dateLabel}`] : []),
    ...(project.statusLabel ? [`状态：${project.statusLabel}`] : []),
    `我的角色：${project.role}`,
    `要解决的问题：${project.problem}`,
    `具体工作：${project.work}`,
    `方法与工具/工作方式：${project.method}`,
    `结果/状态：${project.result}`,
    "如果您想深入了解，欢迎直接从这段经历开始提问。"
  ].join("\n\n");
}
