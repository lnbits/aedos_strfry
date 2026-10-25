/// <reference types="vite/client" />
import { mount } from 'svelte';
import App from './App.svelte';
import './style.css';
import { initializeLanguage } from './i18n';

void initializeLanguage().then(stopLanguageListener => {
  mount(App, { target: document.getElementById('app')! });
  if (import.meta.hot) import.meta.hot.dispose(stopLanguageListener);
});
