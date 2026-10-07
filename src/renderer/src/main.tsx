/** 渲染层入口（electron-vite renderer，index.html 中以 /src/main.tsx 引用）。 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '@renderer/App'
import '@renderer/styles/theme.css'

const host = document.getElementById('root')
if (!host) throw new Error('#root 容器缺失')

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>
)
