/**
 * 自动更新：已手动断开（disabled）。
 *
 * 原因：本包是基于上游的本地定制构建。上游 ooboqoo/interview-coder-cn 会持续
 * 发布新版本，只要 electron-updater 仍然接通，上游一发版就会弹出更新对话框；
 * 用户一旦点「立即重启」，本地所有修复都会被上游二进制整体覆盖，且不可回退。
 *
 * 断开方式（两层，缺一不可）：
 *   1. 本模块不再 import electron-updater，initAutoUpdater() 变成空实现，
 *      运行时不再有任何 checkForUpdates 请求，也不会再弹更新对话框。
 *   2. electron-builder.yml 顶层设置 publish: null，打包时不再生成
 *      resources/app-update.yml，产物根上就没有可用的更新源。
 *
 * 想要恢复自动更新（例如指向自己的私有发布源）时：
 *   - 在 electron-builder.yml 里写回真实的 publish 配置（provider/owner/repo）；
 *   - 把本文件恢复成 checkForUpdates + 事件监听的实现（备份见
 *     D:\projects\_backup\interview-coder-cn\2026-10-08-round3\auto-updater.ts）。
 */
export function initAutoUpdater(): void {
  // 有意为之的空实现：本构建不检查、不下载、不安装任何更新。
}
