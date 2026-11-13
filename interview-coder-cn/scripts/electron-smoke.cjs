/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow } = require('electron')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const assert = require('node:assert/strict')

app.setPath('userData', mkdtempSync(join(tmpdir(), 'assistant-ui-smoke-')))
const errors = []
app.on('web-contents-created', (_event, contents) => {
  contents.on('render-process-gone', (_event, details) => errors.push(details.reason))
})
require('../out/main/index.js')
const deadline = setTimeout(() => {
  console.error('UI smoke timed out')
  app.exit(1)
}, 25000)
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
app.whenReady().then(async () => {
  try {
    let main
    for (let i = 0; i < 100; i++) {
      main = BrowserWindow.getAllWindows().find(
        (window) =>
          window.webContents.getURL().includes('renderer/index.html') &&
          !window.webContents.getURL().includes('toolbar')
      )
      if (main && !main.webContents.isLoading()) break
      await pause(100)
    }
    assert.ok(main)
    await pause(1000)
    await main.webContents.executeJavaScript("window.location.hash='/settings'")
    await pause(500)
    const initial = await main.webContents.executeJavaScript(`({
      text:document.body.innerText,
      platform:document.querySelector('select[aria-label="考试平台"]')?.value,
      nativeDisabled:[...document.querySelectorAll('button')].find(button=>button.textContent.includes('打开原生笔试窗'))?.disabled
    })`)
    assert.ok(initial.text.includes('截图与客户端兼容'))
    assert.ok(initial.text.includes('API Base URL'))
    assert.ok(initial.text.includes('备用'))
    assert.equal(initial.platform, 'auto')
    assert.equal(initial.nativeDisabled, true)
    await main.webContents.executeJavaScript(`{
      const select=document.querySelector('select[aria-label="考试平台"]');
      select.value='iguokao';select.dispatchEvent(new Event('change',{bubbles:true}));
    }`)
    await pause(250)
    main.webContents.reload()
    await pause(1500)
    const persisted = await main.webContents.executeJavaScript(
      `document.querySelector('select[aria-label="考试平台"]')?.value`
    )
    assert.equal(persisted, 'iguokao')
    assert.deepEqual(errors, [])
    const output = process.env.UI_SMOKE_SCREENSHOT
    if (output) writeFileSync(output, (await main.webContents.capturePage()).toPNG())
    console.log(
      JSON.stringify({
        ok: true,
        platform: persisted,
        settings: true,
        fallback: true,
        rendererCrashes: errors.length
      })
    )
    clearTimeout(deadline)
    app.exit(0)
  } catch (error) {
    console.error(error)
    clearTimeout(deadline)
    app.exit(1)
  }
})
