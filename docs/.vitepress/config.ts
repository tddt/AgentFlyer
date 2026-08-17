import { defineConfig } from 'vitepress';

const SITE_ORIGIN = 'https://tddt.github.io';
const SITE_BASE_PATH = '/AgentFlyer';
const SITE_URL = `${SITE_ORIGIN}${SITE_BASE_PATH}`;
const SITE_NAME = 'AgentFlyer';
const REPOSITORY_URL = 'https://github.com/tddt/AgentFlyer';
const LICENSE_URL = `${REPOSITORY_URL}/blob/main/LICENSE`;
const SOCIAL_IMAGE = `${SITE_URL}/console-runtime.svg`;
const SOCIAL_IMAGE_ALT = 'AgentFlyer runtime console preview';
const DEFAULT_DESCRIPTION =
  'AgentOS runtime for multi-agent orchestration, workflows, memory, MCP, sandboxed execution, and multi-channel operations.';
const DEFAULT_ZH_DESCRIPTION =
  '用于多 Agent 协作、工作流、记忆、MCP、受控执行与多通道运营的 AgentOS 运行时。';
const DEFAULT_KEYWORDS = [
  'AgentFlyer',
  'AgentOS',
  'multi-agent runtime',
  'agent orchestration',
  'workflow runtime',
  'operator control plane',
  'MCP',
  'sandboxed AI tools',
  'multi-channel operations',
  'durable memory',
] as const;

type Locale = 'en' | 'zh';

type FaqItem = {
  question: string;
  answer: string;
};

type PageSeoEntry = {
  title: string;
  description: string;
  keywords?: readonly string[];
  section?: string;
  faqItems?: readonly FaqItem[];
};

const PAGE_SEO: Readonly<Record<string, PageSeoEntry>> = {
  '/': {
    title: 'AgentFlyer | Operator-First AgentOS Runtime',
    description:
      'AgentFlyer is a practical AgentOS runtime for multi-agent orchestration, operator workflows, durable memory, deliverables, MCP tooling, sandboxed execution, and multi-channel control.',
    keywords: ['operator-first AI runtime', 'multi-agent system', 'workflow orchestration', 'deliverable tracking'],
    section: 'Homepage',
  },
  '/project-facts': {
    title: 'AgentFlyer Project Facts | Capability Boundaries And Evaluation',
    description:
      'High-signal AgentFlyer facts for evaluators, search engines, and AI systems: product positioning, current capabilities, capability boundaries, and evaluation criteria.',
    keywords: ['project facts', 'capability boundaries', 'agent runtime evaluation', 'AI retrieval summary'],
    section: 'Project Facts',
  },
  '/use-cases': {
    title: 'AgentFlyer Use Cases | Operator Workflows, Research Pipelines, Multi-Agent Teams',
    description:
      'See when AgentFlyer fits best: operator-controlled automation, research-review-publish pipelines, multi-channel command centers, bounded tool execution, and team AgentOS setups.',
    keywords: ['agent use cases', 'operator workflows', 'research publish pipeline', 'multi-channel automation'],
    section: 'Use Cases',
  },
  '/comparison': {
    title: 'AgentFlyer Comparison | AgentOS Runtime Vs Chat Wrappers And Workflow Tools',
    description:
      'Understand how AgentFlyer differs from chat-first assistants, lightweight tool runners, and workflow-only products by comparing runtime shape, control surfaces, and execution boundaries.',
    keywords: ['agent framework comparison', 'chat wrapper alternative', 'workflow runtime comparison'],
    section: 'Comparison',
  },
  '/faq': {
    title: 'AgentFlyer FAQ | Readiness, Federation, Workflows, Extensibility',
    description:
      'Answers to the most common AgentFlyer questions about production readiness, federation status, workflows, extensibility, operator-first design, and runtime surfaces.',
    keywords: ['agent FAQ', 'federation status', 'workflow FAQ', 'operator-first runtime'],
    section: 'FAQ',
    faqItems: [
      {
        question: 'Is AgentFlyer already usable, or is it still just an architecture experiment?',
        answer:
          'AgentFlyer is already usable as a local or single-host AgentOS runtime with runtime behavior, Console UI, CLI, workflows, scheduler, memory, deliverables, channels, MCP, and sandbox support present in the repository.',
      },
      {
        question: 'Is this meant to replace every existing agent framework?',
        answer:
          'No. AgentFlyer focuses on one practical runtime that owns agent execution, workflows, memory, tool access, operator control, and multi-channel delivery without splitting those concerns across stitched-together systems.',
      },
      {
        question: 'Why not just use a chatbot UI with a few tools attached?',
        answer:
          'That approach breaks down when work becomes repeatable, multi-agent, approval-sensitive, or operationally visible. AgentFlyer is for cases where sessions, deliverables, scheduler runs, workflow history, and tool boundaries must stay explicit over time.',
      },
      {
        question: 'Is federation finished?',
        answer:
          'No. Federation exists as an architectural direction with real modules and seams in the codebase, but practical multi-host operations are still expanding.',
      },
      {
        question: 'When should I use workflows instead of chat?',
        answer:
          'Use chat for exploratory work. Use workflows when the process is repeatable, multi-stage, reviewable, schedulable, or expected to produce deliverables instead of transient replies.',
      },
      {
        question: 'How should I think about extensibility?',
        answer:
          'Use the smallest seam that matches the problem: skills for behavior and prompt composition, MCP for external tool access, and plugins for installable npm-packaged runtime extensions.',
      },
    ],
  },
  '/growth-playbook': {
    title: 'AgentFlyer Growth Playbook | Positioning, Proof, Content, Adoption Paths',
    description:
      'A practical marketing and adoption playbook for AgentFlyer covering audience-specific positioning, proof surfaces, content sequencing, and operator-focused messaging.',
    keywords: ['growth playbook', 'open source adoption', 'developer marketing', 'operator-first positioning'],
    section: 'Growth Playbook',
  },
  '/audiences/developers': {
    title: 'AgentFlyer For Developers | Multi-Agent Runtime, Memory, Tools, Control',
    description:
      'Why engineering teams choose AgentFlyer for multi-agent runtime design, workflow orchestration, durable state, sandboxed tools, and operator-visible execution.',
    keywords: ['developers', 'engineering teams', 'agent runtime', 'tool boundaries'],
    section: 'Audience',
  },
  '/audiences/operators': {
    title: 'AgentFlyer For AI Product And Operations Teams | Operator Control Plane',
    description:
      'Learn how AgentFlyer helps AI product and operations teams run approval-aware workflows, deliverables, scheduler jobs, and multi-channel runtime operations.',
    keywords: ['operations teams', 'operator control plane', 'approval workflow', 'AI operations'],
    section: 'Audience',
  },
  '/audiences/enterprise': {
    title: 'AgentFlyer For Enterprise Technology Leaders | Governance, Visibility, Runtime Boundaries',
    description:
      'See how AgentFlyer fits enterprise evaluation with operator visibility, durable state, bounded tool access, workflow governance, and a phased path toward federation.',
    keywords: ['enterprise AI runtime', 'governance', 'visibility', 'bounded execution'],
    section: 'Audience',
  },
  '/audiences/plugin-authors': {
    title: 'AgentFlyer For Plugin Authors | Runtime Extensibility And Package Distribution',
    description:
      'Understand how plugin authors can extend AgentFlyer with installable packages, runtime seams, capability boundaries, and practical developer workflows.',
    keywords: ['plugin authors', 'runtime extensibility', 'package distribution', 'open source contributors'],
    section: 'Audience',
  },
  '/guide/getting-started': {
    title: 'Get Started With AgentFlyer | Install, Configure, Run',
    description:
      'Install AgentFlyer, configure a model, start the runtime, and validate the operator workflow with the Console UI and CLI.',
    keywords: ['getting started', 'install agentflyer', 'console ui', 'cli runtime'],
    section: 'Guide',
  },
  '/guide/architecture': {
    title: 'AgentFlyer Architecture | Runtime Layers, Control Surfaces, Federation Direction',
    description:
      'Read the AgentFlyer architecture: runtime layers, workflows, memory, channels, operator control surfaces, and the path from single-host operation to federation.',
    keywords: ['architecture', 'runtime layers', 'federation direction', 'control surfaces'],
    section: 'Guide',
  },
  '/guide/deployment': {
    title: 'Deploy AgentFlyer | Single-Host Setup, Runtime Operations, Production Boundaries',
    description:
      'Deploy AgentFlyer with a practical single-host path, controlled runtime boundaries, operator surfaces, and an operational progression toward larger-scale usage.',
    keywords: ['deployment', 'single-host runtime', 'production boundaries', 'operator setup'],
    section: 'Guide',
  },
  '/zh': {
    title: 'AgentFlyer | 面向操作者的 AgentOS 运行时',
    description:
      'AgentFlyer 是一套面向操作者的 AgentOS 运行时，统一承载多 Agent 协作、工作流、持久记忆、交付物、MCP 工具、Sandbox 和多通道控制。',
    keywords: ['AgentOS 运行时', '多 Agent 协作', '工作流编排', '操作者控制面'],
    section: '首页',
  },
  '/zh/project-facts': {
    title: 'AgentFlyer 项目事实 | 能力边界与评估要点',
    description:
      '为评估者、搜索引擎与 AI 检索系统准备的高信号总结：定位、当前能力、边界说明与判断清单。',
    keywords: ['项目事实', '能力边界', '评估清单', 'AI 检索摘要'],
    section: '项目事实',
  },
  '/zh/use-cases': {
    title: 'AgentFlyer 适用场景 | 操作者工作流、研究发布流水线、多 Agent 团队',
    description:
      '查看 AgentFlyer 最适合的场景：操作者可控自动化、研究-评审-发布流程、多通道控制中心、受控工具执行与团队级 AgentOS。',
    keywords: ['适用场景', '操作者工作流', '研究发布流程', '多通道自动化'],
    section: '适用场景',
  },
  '/zh/comparison': {
    title: 'AgentFlyer 对比说明 | 相比聊天壳子、工具跑器与工作流工具',
    description:
      '理解 AgentFlyer 与聊天优先助手、轻量工具跑器、workflow-only 产品在系统形态、控制面和执行边界上的差异。',
    keywords: ['对比说明', '聊天壳子替代', '工作流运行时对比'],
    section: '对比说明',
  },
  '/zh/faq': {
    title: 'AgentFlyer 常见问题 | 可用性、联邦化、工作流、扩展性',
    description:
      '集中回答 AgentFlyer 的核心问题：当前可用性、联邦化进展、工作流、扩展方式、operator-first 设计与运行时表面。',
    keywords: ['常见问题', '联邦化进展', '工作流 FAQ', '操作者优先'],
    section: '常见问题',
    faqItems: [
      {
        question: 'AgentFlyer 现在已经能用，还是只是架构实验？',
        answer:
          '它已经可以作为本地或单机 AgentOS 运行时使用，仓库中已经包含核心运行时、Console UI、CLI、workflow、scheduler、memory、deliverables、channels、MCP 与 sandbox 支持。',
      },
      {
        question: '它的目标是替代所有 Agent 框架吗？',
        answer:
          '不是。AgentFlyer 更聚焦于用一套统一运行时承载 agent 执行、workflow、memory、工具访问、operator control 与多通道交付，而不是把这些能力拆散到多个临时系统中。',
      },
      {
        question: '为什么不直接用带少量工具的聊天 UI？',
        answer:
          '当工作开始变成可重复、多 Agent、审批敏感或需要操作可见性时，这种做法会很快失效。AgentFlyer 适用于需要让 sessions、deliverables、scheduler runs、workflow 历史和工具边界长期保持显式的场景。',
      },
      {
        question: 'Federation 已经完成了吗？',
        answer:
          '没有。Federation 已作为明确架构方向进入代码树，具备真实模块与接口边界，但实用化的多主机协作仍在持续扩展中。',
      },
      {
        question: '什么时候该用 workflow，而不是 chat？',
        answer:
          '探索性工作用 chat；当流程需要可重复、多阶段、可审查、可调度，或者要产出 deliverables 而不只是瞬时回复时，就该用 workflow。',
      },
      {
        question: '应该怎样理解它的扩展性？',
        answer:
          '用最贴合问题的最小扩展面：skills 处理行为与 prompt 组合，MCP 负责外部工具接入，plugins 负责可安装的 npm 运行时扩展。',
      },
    ],
  },
  '/zh/growth-playbook': {
    title: 'AgentFlyer 增长手册 | 定位、证据、内容与采用路径',
    description:
      '一份面向开源推广与采用的实战手册，覆盖 AgentFlyer 的角色化定位、证明材料、内容顺序与 operator-focused 叙事。',
    keywords: ['增长手册', '开源推广', '开发者营销', '产品定位'],
    section: '增长手册',
  },
  '/zh/audiences/developers': {
    title: 'AgentFlyer 面向开发者与技术团队 | 多 Agent 运行时、记忆、工具与控制',
    description:
      '说明工程团队为什么会选择 AgentFlyer：多 Agent 运行时、workflow 编排、持久状态、sandbox 工具访问与 operator 可见执行。',
    keywords: ['开发者', '技术团队', 'Agent 运行时', '工具边界'],
    section: '按角色选择',
  },
  '/zh/audiences/operators': {
    title: 'AgentFlyer 面向 AI 产品与运营团队 | 操作者控制平面',
    description:
      '了解 AgentFlyer 如何帮助 AI 产品与运营团队运行带审批的 workflow、deliverables、scheduler 任务和多通道运行时操作。',
    keywords: ['运营团队', '操作者控制面', '审批工作流', 'AI 运营'],
    section: '按角色选择',
  },
  '/zh/audiences/enterprise': {
    title: 'AgentFlyer 面向企业技术决策者 | 治理、可见性与运行时边界',
    description:
      '从治理、可见性、持久状态、受控工具访问与渐进式联邦路径角度，评估 AgentFlyer 的企业适配性。',
    keywords: ['企业 AI 运行时', '治理', '可见性', '受控执行'],
    section: '按角色选择',
  },
  '/zh/audiences/plugin-authors': {
    title: 'AgentFlyer 面向插件作者与开源贡献者 | 运行时扩展与包分发',
    description:
      '帮助插件作者理解 AgentFlyer 的扩展面、能力边界、可安装包机制与面向开源贡献者的开发方式。',
    keywords: ['插件作者', '运行时扩展', '包分发', '开源贡献者'],
    section: '按角色选择',
  },
  '/zh/guide/getting-started': {
    title: 'AgentFlyer 快速开始 | 安装、配置与运行',
    description:
      '安装 AgentFlyer、配置模型、启动运行时，并通过 Console UI 与 CLI 验证首条 operator workflow。',
    keywords: ['快速开始', '安装 AgentFlyer', 'Console UI', 'CLI 运行时'],
    section: '指南',
  },
  '/zh/guide/architecture': {
    title: 'AgentFlyer 架构 | 运行时分层、控制表面与联邦方向',
    description:
      '阅读 AgentFlyer 的架构说明：运行时分层、workflow、memory、channels、operator control surface 与从单机到联邦的演进路径。',
    keywords: ['架构', '运行时分层', '联邦方向', '控制表面'],
    section: '指南',
  },
  '/zh/guide/deployment': {
    title: '部署 AgentFlyer | 单机落地、运行时操作与生产边界',
    description:
      '通过务实的单机路径部署 AgentFlyer，并逐步建立受控边界、operator surface 与可运营的运行时流程。',
    keywords: ['部署', '单机运行时', '生产边界', '操作者设置'],
    section: '指南',
  },
};

const SEGMENT_LABELS: Readonly<Record<string, Readonly<Record<Locale, string>>>> = {
  audiences: { en: 'By Role', zh: '按角色选择' },
  guide: { en: 'Guide', zh: '指南' },
  api: { en: 'API Reference', zh: 'API 参考' },
  plugins: { en: 'Plugins', zh: '插件' },
};

function normalizeRoute(path: string): string {
  const cleaned = path
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/index$/, '')
    .replace(/\/+$/, '');

  return cleaned.length > 0 ? `/${cleaned}` : '/';
}

function buildLocalizedRoute(relativePath: string, locale: Locale): string {
  // RATIONALE: VitePress uses `zh/index.md` for the Chinese root page, which normalizes to `zh`.
  // We map that sentinel route to zh root for canonical/hreflang generation.
  // RATIONALE: `zh/*` is a reserved locale namespace in this docs tree.
  const contentPath =
    relativePath === 'zh' ? '' : relativePath.startsWith('zh/') ? relativePath.slice(3) : relativePath;

  if (locale === 'zh') {
    return normalizeRoute(contentPath.length > 0 ? `zh/${contentPath}` : 'zh');
  }

  return normalizeRoute(contentPath);
}

function toAbsoluteUrl(route: string): string {
  return `${SITE_URL}${route === '/' ? '' : route}`;
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function resolveSeoEntry(route: string, locale: Locale, pageTitle: string): PageSeoEntry {
  const fallbackDescription = locale === 'zh' ? DEFAULT_ZH_DESCRIPTION : DEFAULT_DESCRIPTION;
  const fallbackTitle = pageTitle.length > 0 ? `${pageTitle} | ${SITE_NAME}` : SITE_NAME;
  const entry = PAGE_SEO[route];

  return (
    entry ?? {
      title: fallbackTitle,
      description: fallbackDescription,
    }
  );
}

function resolveKeywords(entry: PageSeoEntry): string {
  return dedupeStrings([...DEFAULT_KEYWORDS, ...(entry.keywords ?? [])]).join(', ');
}

function humanizeSegment(segment: string): string {
  return segment
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function isLocalizedHomeRoute(route: string): boolean {
  return route === '/' || route === '/zh';
}

function buildBreadcrumbs(route: string, locale: Locale): Array<{ name: string; item: string }> {
  const rootRoute = locale === 'zh' ? '/zh' : '/';
  const rootLabel = locale === 'zh' ? 'AgentFlyer 文档' : 'AgentFlyer Docs';
  const breadcrumbs: Array<{ name: string; item: string }> = [
    { name: rootLabel, item: toAbsoluteUrl(rootRoute) },
  ];

  if (route === rootRoute) {
    return breadcrumbs;
  }

  const segments = route.replace(/^\/+/, '').split('/').filter(Boolean);
  const pathSegments = locale === 'zh' ? segments.slice(1) : segments;
  const activeSegments = locale === 'zh' ? ['zh'] : [];

  for (const segment of pathSegments) {
    activeSegments.push(segment);
    const currentRoute = normalizeRoute(activeSegments.join('/'));
    const label =
      PAGE_SEO[currentRoute]?.title ??
      SEGMENT_LABELS[segment]?.[locale] ??
      humanizeSegment(segment);
    breadcrumbs.push({ name: label, item: toAbsoluteUrl(currentRoute) });
  }

  return breadcrumbs;
}

function buildStructuredData(route: string, locale: Locale, entry: PageSeoEntry): Record<string, unknown> {
  const canonicalUrl = toAbsoluteUrl(route);
  const inLanguage = locale === 'zh' ? 'zh-CN' : 'en-US';
  const breadcrumbs = buildBreadcrumbs(route, locale);
  const graph: Record<string, unknown>[] = [
    {
      '@type': 'Organization',
      name: `${SITE_NAME} Contributors`,
      url: SITE_URL,
      sameAs: [REPOSITORY_URL],
    },
    {
      '@type': 'WebSite',
      name: SITE_NAME,
      url: SITE_URL,
      inLanguage: ['en-US', 'zh-CN'],
      description: DEFAULT_DESCRIPTION,
      publisher: {
        '@type': 'Organization',
        name: `${SITE_NAME} Contributors`,
      },
    },
    {
      '@type': 'SoftwareApplication',
      name: SITE_NAME,
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Linux, macOS, Windows',
      license: LICENSE_URL,
      codeRepository: REPOSITORY_URL,
      url: SITE_URL,
      image: SOCIAL_IMAGE,
      description: DEFAULT_DESCRIPTION,
      offers: {
        '@type': 'Offer',
        price: '0',
        priceCurrency: 'USD',
      },
    },
    {
      '@type': 'SoftwareSourceCode',
      name: SITE_NAME,
      codeRepository: REPOSITORY_URL,
      license: LICENSE_URL,
      programmingLanguage: ['TypeScript', 'JavaScript'],
      runtimePlatform: 'Bun >= 1.2, Node.js >= 22',
      url: REPOSITORY_URL,
      description: DEFAULT_DESCRIPTION,
    },
    {
      '@type': isLocalizedHomeRoute(route) ? 'WebPage' : 'TechArticle',
      headline: entry.title,
      name: entry.title,
      description: entry.description,
      url: canonicalUrl,
      inLanguage,
      image: SOCIAL_IMAGE,
      isPartOf: {
        '@type': 'WebSite',
        name: SITE_NAME,
        url: SITE_URL,
      },
      author: {
        '@type': 'Organization',
        name: `${SITE_NAME} Contributors`,
      },
      publisher: {
        '@type': 'Organization',
        name: `${SITE_NAME} Contributors`,
      },
      keywords: resolveKeywords(entry),
      ...(entry.section ? { articleSection: entry.section } : {}),
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: breadcrumbs.map((breadcrumb, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: breadcrumb.name,
        item: breadcrumb.item,
      })),
    },
  ];

  if (entry.faqItems) {
    graph.push({
      '@type': 'FAQPage',
      mainEntity: entry.faqItems.map((item) => ({
        '@type': 'Question',
        name: item.question,
        acceptedAnswer: {
          '@type': 'Answer',
          text: item.answer,
        },
      })),
    });
  }

  return {
    '@context': 'https://schema.org',
    '@graph': graph,
  };
}

function getThemeConfig(locale: Locale) {
  const prefix = locale === 'zh' ? '/zh' : '';
  const guidePrefix = `${prefix}/guide`;
  const apiPrefix = `${prefix}/api`;
  const pluginsPrefix = `${prefix}/plugins`;
  const audiencesPrefix = `${prefix}/audiences`;

  if (locale === 'zh') {
    return {
      nav: [
        { text: '为什么是 AgentFlyer', link: '/zh/#why-agentflyer' },
        { text: '按角色选择', link: '/zh/audiences/developers' },
        { text: '项目事实', link: '/zh/project-facts' },
        { text: 'H5 介绍', link: '/zh/h5-intro' },
        { text: '适用场景', link: '/zh/use-cases' },
        { text: '指南', link: '/zh/guide/getting-started' },
        { text: '架构', link: '/zh/guide/architecture' },
        { text: '路线图', link: '/zh/roadmap' },
        { text: '常见问题', link: '/zh/faq' },
        { text: 'GitHub', link: 'https://github.com/tddt/AgentFlyer' },
      ],
      sidebar: {
        '/zh/guide/': [
          {
            text: '指南',
            items: [
              { text: '快速开始', link: `${guidePrefix}/getting-started` },
              { text: '架构', link: `${guidePrefix}/architecture` },
              { text: '配置', link: `${guidePrefix}/configuration` },
              { text: 'Agents', link: `${guidePrefix}/agents` },
              { text: 'Workflows', link: `${guidePrefix}/workflows` },
              { text: 'Channels', link: `${guidePrefix}/channels` },
              { text: 'Skills 与 Tools', link: `${guidePrefix}/skills` },
              { text: 'Memory', link: `${guidePrefix}/memory` },
              { text: 'Federation', link: `${guidePrefix}/federation` },
              { text: '部署', link: `${guidePrefix}/deployment` },
            ],
          },
        ],
        '/zh/audiences/': [
          {
            text: '按角色选择',
            items: [
              { text: '开发者与技术团队', link: `${audiencesPrefix}/developers` },
              { text: 'AI 产品与运营团队', link: `${audiencesPrefix}/operators` },
              { text: '企业技术决策者', link: `${audiencesPrefix}/enterprise` },
              { text: '插件作者与开源贡献者', link: `${audiencesPrefix}/plugin-authors` },
            ],
          },
        ],
        '/zh/api/': [
          {
            text: '参考',
            items: [
              { text: 'RPC 参考', link: `${apiPrefix}/rpc-reference` },
              { text: '事件与流式接口', link: `${apiPrefix}/events` },
              { text: '扩展入口', link: `${apiPrefix}/plugin-sdk` },
            ],
          },
        ],
        '/zh/plugins/': [
          {
            text: '扩展',
            items: [
              { text: '概览', link: `${pluginsPrefix}/overview` },
              { text: '发布插件包', link: `${pluginsPrefix}/writing` },
              { text: '市场', link: `${pluginsPrefix}/marketplace` },
            ],
          },
        ],
      },
      socialLinks: [{ icon: 'github', link: 'https://github.com/tddt/AgentFlyer' }],
      footer: {
        message: 'MIT License。Bun 优先，兼容 Node。为操作者而不是 Demo 设计。',
        copyright: 'Copyright © AgentFlyer Contributors',
      },
      docFooter: {
        prev: '上一页',
        next: '下一页',
      },
      outline: {
        label: '本页内容',
      },
      search: {
        provider: 'local',
        options: {
          locales: {
            root: {
              translations: {
                button: {
                  buttonText: '搜索',
                  buttonAriaLabel: '搜索',
                },
                modal: {
                  noResultsText: '没有结果',
                  resetButtonTitle: '清空查询',
                  footer: {
                    selectText: '选择',
                    navigateText: '切换',
                    closeText: '关闭',
                  },
                },
              },
            },
          },
        },
      },
    };
  }

  return {
    nav: [
      { text: 'Why AgentFlyer', link: '/#why-agentflyer' },
      { text: 'By Role', link: '/audiences/developers' },
      { text: 'Project Facts', link: '/project-facts' },
      { text: 'Use Cases', link: '/use-cases' },
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Architecture', link: '/guide/architecture' },
      { text: 'Roadmap', link: '/roadmap' },
      { text: 'FAQ', link: '/faq' },
      { text: 'Reference', link: '/api/rpc-reference' },
      { text: 'GitHub', link: 'https://github.com/tddt/AgentFlyer' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Getting Started', link: `${guidePrefix}/getting-started` },
            { text: 'Architecture', link: `${guidePrefix}/architecture` },
            { text: 'Configuration', link: `${guidePrefix}/configuration` },
            { text: 'Agents', link: `${guidePrefix}/agents` },
            { text: 'Workflows', link: `${guidePrefix}/workflows` },
            { text: 'Channels', link: `${guidePrefix}/channels` },
            { text: 'Skills And Tools', link: `${guidePrefix}/skills` },
            { text: 'Memory', link: `${guidePrefix}/memory` },
            { text: 'Federation', link: `${guidePrefix}/federation` },
            { text: 'Deployment', link: `${guidePrefix}/deployment` },
          ],
        },
      ],
      '/audiences/': [
        {
          text: 'By Role',
          items: [
            { text: 'Developers & Engineering Teams', link: `${audiencesPrefix}/developers` },
            { text: 'AI Product & Operations Teams', link: `${audiencesPrefix}/operators` },
            { text: 'Enterprise Technology Leaders', link: `${audiencesPrefix}/enterprise` },
            { text: 'Plugin Authors & OSS Contributors', link: `${audiencesPrefix}/plugin-authors` },
          ],
        },
      ],
      '/api/': [
        {
          text: 'Reference',
          items: [
            { text: 'RPC Reference', link: `${apiPrefix}/rpc-reference` },
            { text: 'Events', link: `${apiPrefix}/events` },
            { text: 'Extension Surfaces', link: `${apiPrefix}/plugin-sdk` },
          ],
        },
      ],
      '/plugins/': [
        {
          text: 'Extensibility',
          items: [
            { text: 'Overview', link: `${pluginsPrefix}/overview` },
            { text: 'Publishing Packages', link: `${pluginsPrefix}/writing` },
            { text: 'Marketplace', link: `${pluginsPrefix}/marketplace` },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/tddt/AgentFlyer' }],
    footer: {
      message: 'MIT licensed. Bun-first. Node-compatible. Built for operators, not demos.',
      copyright: 'Copyright © AgentFlyer Contributors',
    },
    search: {
      provider: 'local',
    },
  };
}

export default defineConfig({
  title: SITE_NAME,
  description: DEFAULT_DESCRIPTION,
  appearance: false,
  base: '/AgentFlyer/',
  sitemap: {
    hostname: SITE_URL,
  },
  transformHead: ({ pageData }) => {
    const relativePath = pageData.relativePath
      .replace(/\.md$/, '')
      .replace(/\/index$/, '')
      .replace(/^index$/, '');
    const isZhPage = relativePath === 'zh' || relativePath.startsWith('zh/');

    const currentLocale: Locale = isZhPage ? 'zh' : 'en';
    const canonicalRoute = buildLocalizedRoute(relativePath, currentLocale);
    const englishRoute = buildLocalizedRoute(relativePath, 'en');
    const chineseRoute = buildLocalizedRoute(relativePath, 'zh');
    const canonicalUrl = toAbsoluteUrl(canonicalRoute);
    const entry = resolveSeoEntry(canonicalRoute, currentLocale, pageData.title);
    const ogType = isLocalizedHomeRoute(canonicalRoute) ? 'website' : 'article';

    return [
      ['meta', { name: 'description', content: entry.description }],
      ['meta', { name: 'keywords', content: resolveKeywords(entry) }],
      ['link', { rel: 'canonical', href: canonicalUrl }],
      ['link', { rel: 'alternate', hreflang: 'en', href: toAbsoluteUrl(englishRoute) }],
      ['link', { rel: 'alternate', hreflang: 'zh-CN', href: toAbsoluteUrl(chineseRoute) }],
      ['link', { rel: 'alternate', hreflang: 'x-default', href: toAbsoluteUrl(englishRoute) }],
      ['meta', { property: 'og:title', content: entry.title }],
      ['meta', { property: 'og:description', content: entry.description }],
      ['meta', { property: 'og:url', content: canonicalUrl }],
      ['meta', { property: 'og:type', content: ogType }],
      ['meta', { property: 'og:site_name', content: SITE_NAME }],
      ['meta', { property: 'og:image', content: SOCIAL_IMAGE }],
      ['meta', { property: 'og:image:alt', content: SOCIAL_IMAGE_ALT }],
      ['meta', { property: 'og:locale', content: isZhPage ? 'zh_CN' : 'en_US' }],
      ['meta', { property: 'og:locale:alternate', content: isZhPage ? 'en_US' : 'zh_CN' }],
      ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
      ['meta', { name: 'twitter:title', content: entry.title }],
      ['meta', { name: 'twitter:description', content: entry.description }],
      ['meta', { name: 'twitter:image', content: SOCIAL_IMAGE }],
      ['meta', { name: 'twitter:image:alt', content: SOCIAL_IMAGE_ALT }],
      ['meta', { name: 'author', content: `${SITE_NAME} Contributors` }],
      [
        'script',
        { type: 'application/ld+json' },
        JSON.stringify(buildStructuredData(canonicalRoute, currentLocale, entry)),
      ],
    ];
  },
  head: [
    ['meta', { name: 'theme-color', content: '#0d3b36' }],
    ['meta', { name: 'robots', content: 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1' }],
    ['meta', { name: 'application-name', content: SITE_NAME }],
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${SITE_BASE_PATH}/favicon.svg` }],
    ['link', { rel: 'manifest', href: `${SITE_BASE_PATH}/site.webmanifest` }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    [
      'link',
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap',
      },
    ],
  ],
  locales: {
    root: {
      label: 'English',
      lang: 'en-US',
      title: SITE_NAME,
      description: DEFAULT_DESCRIPTION,
      themeConfig: getThemeConfig('en'),
    },
    zh: {
      label: '中文',
      lang: 'zh-CN',
      link: '/zh/',
      title: SITE_NAME,
      description: DEFAULT_ZH_DESCRIPTION,
      themeConfig: getThemeConfig('zh'),
    },
  },
});
