import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import './custom.css';
import H5IntroPage from './components/H5IntroPage.vue';

const theme: Theme = {
  ...DefaultTheme,
  enhanceApp({ app }) {
    app.component('H5IntroPage', H5IntroPage);
  },
};

export default theme;