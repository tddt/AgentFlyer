import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'AgentFlyer',
  description: 'Decentralized, cross-platform, multi-host federated AI Agent framework',
  base: '/',
  head: [['link', { rel: 'icon', href: '/favicon.ico' }]],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API', link: '/api/rpc-reference' },
      { text: 'Plugins', link: '/plugins/overview' },
      { text: 'Changelog', link: '/changelog' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Configuration', link: '/guide/configuration' },
            { text: 'Agents', link: '/guide/agents' },
            { text: 'Skills (tools)', link: '/guide/skills' },
            { text: 'Memory', link: '/guide/memory' },
            { text: 'Federation', link: '/guide/federation' },
            { text: 'Deployment', link: '/guide/deployment' },
          ],
        },
      ],
      '/api/': [
        {
          text: 'API Reference',
          items: [
            { text: 'RPC Reference', link: '/api/rpc-reference' },
            { text: 'Events', link: '/api/events' },
            { text: 'Plugin SDK', link: '/api/plugin-sdk' },
          ],
        },
      ],
      '/plugins/': [
        {
          text: 'Plugins',
          items: [
            { text: 'Overview', link: '/plugins/overview' },
            { text: 'Writing a Plugin', link: '/plugins/writing' },
            { text: 'Marketplace', link: '/plugins/marketplace' },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/agentflyer/agentflyer' },
    ],
    footer: {
      message: 'Released under the Apache 2.0 License.',
      copyright: 'Copyright © AgentFlyer Contributors',
    },
    search: {
      provider: 'local',
    },
  },
});
