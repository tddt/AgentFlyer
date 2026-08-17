import { defineConfig } from 'vitepress';

const SITE_ORIGIN = 'https://tddt.github.io';
const SITE_BASE_PATH = '/AgentFlyer';
const SITE_URL = `${SITE_ORIGIN}${SITE_BASE_PATH}`;
const SOCIAL_IMAGE = `${SITE_URL}/console-runtime.svg`;

function normalizeRoute(path: string): string {
  const cleaned = path
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/index$/, '')
    .replace(/\/+$/, '');

  return cleaned.length > 0 ? `/${cleaned}` : '/';
}

function buildLocalizedRoute(relativePath: string, locale: 'en' | 'zh'): string {
  const contentPath = relativePath.startsWith('zh/') ? relativePath.slice(3) : relativePath;

  if (locale === 'zh') {
    return normalizeRoute(contentPath.length > 0 ? `zh/${contentPath}` : 'zh');
  }

  return normalizeRoute(contentPath);
}

function toAbsoluteUrl(route: string): string {
  return `${SITE_URL}${route === '/' ? '' : route}`;
}

function getThemeConfig(locale: 'en' | 'zh') {
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
  title: 'AgentFlyer',
  description: 'AgentOS runtime for multi-agent orchestration, workflows, memory, MCP, sandboxed execution, and multi-channel operations.',
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
    const isZhPage = relativePath.startsWith('zh/');

    const currentLocale = isZhPage ? 'zh' : 'en';
    const canonicalRoute = buildLocalizedRoute(relativePath, currentLocale);
    const englishRoute = buildLocalizedRoute(relativePath, 'en');
    const chineseRoute = buildLocalizedRoute(relativePath, 'zh');
    const canonicalUrl = toAbsoluteUrl(canonicalRoute);

    return [
      ['link', { rel: 'canonical', href: canonicalUrl }],
      ['link', { rel: 'alternate', hreflang: 'en', href: toAbsoluteUrl(englishRoute) }],
      ['link', { rel: 'alternate', hreflang: 'zh-CN', href: toAbsoluteUrl(chineseRoute) }],
      ['link', { rel: 'alternate', hreflang: 'x-default', href: toAbsoluteUrl(englishRoute) }],
      ['meta', { property: 'og:url', content: canonicalUrl }],
      ['meta', { property: 'og:locale', content: isZhPage ? 'zh_CN' : 'en_US' }],
      ['meta', { property: 'og:locale:alternate', content: isZhPage ? 'en_US' : 'zh_CN' }],
    ];
  },
  head: [
    ['meta', { name: 'theme-color', content: '#0d3b36' }],
    ['meta', { name: 'keywords', content: 'AgentFlyer, AgentOS, multi-agent runtime, agent orchestration, workflow runtime, MCP, sandboxed AI tools, operator control plane, federation-ready' }],
    ['meta', { name: 'robots', content: 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'AgentFlyer' }],
    ['meta', { property: 'og:title', content: 'AgentFlyer' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'A practical AgentOS runtime with workflows, memory, MCP, sandboxing, multi-agent mesh, and operator-facing control surfaces.',
      },
    ],
    ['meta', { property: 'og:image', content: SOCIAL_IMAGE }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: 'AgentFlyer' }],
    ['meta', { name: 'twitter:description', content: 'A practical AgentOS runtime for multi-agent orchestration, operator workflows, and controlled tool execution.' }],
    ['meta', { name: 'twitter:image', content: SOCIAL_IMAGE }],
    ['link', { rel: 'icon', href: '/favicon.ico' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    [
      'script',
      { type: 'application/ld+json' },
      JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'Organization',
            name: 'AgentFlyer Contributors',
            url: SITE_URL,
            sameAs: ['https://github.com/tddt/AgentFlyer'],
          },
          {
            '@type': 'SoftwareApplication',
            name: 'AgentFlyer',
            applicationCategory: 'DeveloperApplication',
            operatingSystem: 'Linux, macOS, Windows',
            softwareVersion: '1.2.x',
            license: 'https://github.com/tddt/AgentFlyer/blob/main/LICENSE',
            codeRepository: 'https://github.com/tddt/AgentFlyer',
            url: SITE_URL,
            description:
              'AgentOS runtime for multi-agent orchestration, workflows, memory, deliverables, MCP, sandboxed execution, and multi-channel operations.',
            offers: {
              '@type': 'Offer',
              price: '0',
              priceCurrency: 'USD',
            },
          },
          {
            '@type': 'TechArticle',
            headline: 'AgentFlyer Documentation',
            description:
              'Operator-first documentation for AgentFlyer covering architecture, workflows, memory, channels, deployment, and capability boundaries.',
            inLanguage: ['en-US', 'zh-CN'],
            mainEntityOfPage: `${SITE_URL}/project-facts`,
            author: {
              '@type': 'Organization',
              name: 'AgentFlyer Contributors',
            },
            publisher: {
              '@type': 'Organization',
              name: 'AgentFlyer Contributors',
            },
          },
        ],
      }),
    ],
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
      title: 'AgentFlyer',
      description:
        'AgentOS runtime for multi-agent orchestration, workflows, memory, MCP, sandboxed execution, and multi-channel operations.',
      themeConfig: getThemeConfig('en'),
    },
    zh: {
      label: '中文',
      lang: 'zh-CN',
      link: '/zh/',
      title: 'AgentFlyer',
      description: '用于多 Agent 协作、工作流、记忆、MCP、受控执行与多通道运营的 AgentOS 运行时。',
      themeConfig: getThemeConfig('zh'),
    },
  },
});
