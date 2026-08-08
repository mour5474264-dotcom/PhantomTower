import { createApp } from 'vue';
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import { createPinia } from 'pinia';
import { createRouter, createWebHashHistory } from 'vue-router';
import App from './App.vue';
import './styles.css';
import './fixes.css';
import './workspace-fixes.css';
import './workspace-interactions.css';
import './history.css';
import './generation-lock.css';
import './custom-size.css';
import './interaction-polish.css';
import './element-workspace.css';
const router=createRouter({history:createWebHashHistory(),routes:[{path:'/',component:()=>import('./views/Workspace.vue')},{path:'/library',component:()=>import('./views/Library.vue')},{path:'/presets',component:()=>import('./views/Presets.vue')},{path:'/history',component:()=>import('./views/History.vue')},{path:'/apis',component:()=>import('./views/ApiManagement.vue')} ]});
createApp(App).use(createPinia()).use(router).use(ElementPlus).mount('#app');
