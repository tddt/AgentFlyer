import { defineConfig } from 'vitepress';

function getThemeConfig(locale: 'en' | 'zh') {
  const prefix = locale === 'zh' ? '/zh' : '';
  const guidePrefix = `${prefix}/guide`;
  const apiPrefix = `${prefix}/api`;
  const pluginsPrefix = `${prefix}/plugins`;
  const growthPrefix = `${prefix}/growth`;

  if (locale === 'zh') {
    return {
      nav: [
        { text: '为什么是 AgentFlyer', link: '/zh/#why-agentflyer' },
        { text: 'H5 介绍', link: '/zh/h5-intro' },
        { text: '适用场景', link: '/zh/use-cases' },
        { text: '指南', link: '/zh/guide/getting-started' },
        { text: '架构', link: '/zh/guide/architecture' },
        { text: '路线图', link: '/zh/roadmap' },
        { text: '常见问题', link: '/zh/faq' },
        { text: '增长手册', link: '/zh/growth/launch-playbook' },
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
        '/zh/growth/': [
          {
            text: '增长',
            items: [
              { text: '30 天执行手册', link: `${growthPrefix}/launch-playbook` },
              { text: '介绍文模板', link: `${growthPrefix}/intro-post-template` },
              { text: '渠道帖子模板', link: `${growthPrefix}/channel-post-templates` },
              { text: '指标基线', link: `${growthPrefix}/analytics-baseline` },
              { text: '周复盘模板', link: `${growthPrefix}/weekly-retro-template` },
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
      { text: 'Use Cases', link: '/use-cases' },
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Architecture', link: '/guide/architecture' },
      { text: 'Roadmap', link: '/roadmap' },
      { text: 'FAQ', link: '/faq' },
      { text: 'Growth', link: '/growth/launch-playbook' },
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
      '/growth/': [
        {
          text: 'Growth',
          items: [
            { text: '30-Day Launch Playbook', link: `${growthPrefix}/launch-playbook` },
            { text: 'Intro Post Template', link: `${growthPrefix}/intro-post-template` },
            { text: 'Channel Post Templates', link: `${growthPrefix}/channel-post-templates` },
            { text: 'Analytics Baseline', link: `${growthPrefix}/analytics-baseline` },
            { text: 'Weekly Retro Template', link: `${growthPrefix}/weekly-retro-template` },
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
  head: [
    ['meta', { name: 'theme-color', content: '#0d3b36' }],
    ['meta', { property: 'og:title', content: 'AgentFlyer' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'A practical AgentOS runtime with workflows, memory, MCP, sandboxing, multi-agent mesh, and operator-facing control surfaces.',
      },
    ],
    ['link', { rel: 'icon', href: '/favicon.ico' }],
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
