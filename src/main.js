import { createApp } from 'vue';
import {
  ElAlert,
  ElButton,
  ElCheckbox,
  ElDialog,
  ElEmpty,
  ElForm,
  ElFormItem,
  ElIcon,
  ElImage,
  ElInput,
  ElInputNumber,
  ElOption,
  ElRadioButton,
  ElRadioGroup,
  ElSelect,
  ElSwitch,
  ElTabPane,
  ElTable,
  ElTableColumn,
  ElTabs,
  ElUpload
} from 'element-plus'
import 'element-plus/es/components/alert/style/css'
import 'element-plus/es/components/button/style/css'
import 'element-plus/es/components/checkbox/style/css'
import 'element-plus/es/components/dialog/style/css'
import 'element-plus/es/components/empty/style/css'
import 'element-plus/es/components/form/style/css'
import 'element-plus/es/components/form-item/style/css'
import 'element-plus/es/components/icon/style/css'
import 'element-plus/es/components/image/style/css'
import 'element-plus/es/components/input/style/css'
import 'element-plus/es/components/input-number/style/css'
import 'element-plus/es/components/option/style/css'
import 'element-plus/es/components/radio-button/style/css'
import 'element-plus/es/components/radio-group/style/css'
import 'element-plus/es/components/select/style/css'
import 'element-plus/es/components/switch/style/css'
import 'element-plus/es/components/tab-pane/style/css'
import 'element-plus/es/components/table/style/css'
import 'element-plus/es/components/table-column/style/css'
import 'element-plus/es/components/tabs/style/css'
import 'element-plus/es/components/upload/style/css'
import 'element-plus/es/components/message/style/css'
import 'element-plus/es/components/message-box/style/css'
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
import './compact-workspace.css';
import './prototype-layout.css';
import './prototype-refine.css';
import './prototype-studio.css';
import './v5-theme.css';
import './v5-global-fix.css';
import './v5-structure.css';
import './v5-interaction-fix.css';
import './v5-viewport-fix.css';
import './v5-config-column.css';
import './v5-generation-bar.css';
import './v5-status-height-fix.css';
import './v5-result-focus.css';
import './upload-progress.css';
import './v5-material-width.css';
import './preview-progress-fix.css';
import './upload-workbench.css';
import './edit-region.css';
import './generation-panel-layout.css';
import './top-workspace-layout.css';
import './composer-layout.css';
import './secondary-pages.css';
const router=createRouter({history:createWebHashHistory(),routes:[{path:'/',component:()=>import('./views/Workspace.vue')},{path:'/library',component:()=>import('./views/Library.vue')},{path:'/presets',component:()=>import('./views/Presets.vue')},{path:'/history',component:()=>import('./views/History.vue')},{path:'/apis',component:()=>import('./views/ApiManagement.vue')},{path:'/settings',component:()=>import('./views/Settings.vue')} ]});
const app = createApp(App).use(createPinia()).use(router)
const elementComponents = {
  ElAlert, ElButton, ElCheckbox, ElDialog, ElEmpty, ElForm, ElFormItem,
  ElIcon, ElImage, ElInput, ElInputNumber, ElOption, ElRadioButton,
  ElRadioGroup, ElSelect, ElSwitch, ElTabPane, ElTable, ElTableColumn,
  ElTabs, ElUpload
}
Object.entries(elementComponents).forEach(([name, component]) => app.component(name, component))
app.mount('#app')
