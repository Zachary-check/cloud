/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow } = require('electron')
const { mkdtempSync, writeFileSync, readdirSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const assert = require('node:assert/strict')
const { Worker } = require('node:worker_threads')

app.setPath('userData', mkdtempSync(join(tmpdir(), 'assistant-ui-smoke-')))
const errors = []
app.on('web-contents-created', (_event, contents) => {
  contents.on('render-process-gone', (_event, details) => errors.push(details.reason))
})
require('../out/main/index.js')
const deadline = setTimeout(() => {
  console.error('UI smoke timed out')
  app.exit(1)
}, 45000)
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
      nativeDisabled:[...document.querySelectorAll('button')].find(button=>button.textContent.includes('打开原生笔试窗'))?.disabled,
      textOnly:document.querySelector('input[aria-label="纯文字答案"]')?.checked,
      previews:document.querySelector('input[aria-label="显示截图缩略图"]')?.checked
    })`)
    assert.ok(initial.text.includes('截图与客户端兼容'))
    assert.ok(initial.text.includes('API Base URL'))
    assert.ok(initial.text.includes('备用'))
    assert.equal(initial.platform, 'auto')
    if (process.platform !== 'win32') assert.equal(initial.nativeDisabled, true)
    assert.equal(initial.textOnly, true)
    assert.equal(initial.previews, false)
    await main.webContents.executeJavaScript(`{
      const select=document.querySelector('select[aria-label="考试平台"]');
      select.value='iguokao';select.dispatchEvent(new Event('change',{bubbles:true}));
      document.querySelector('input[aria-label="显示截图缩略图"]').click();
    }`)
    await pause(250)
    main.webContents.reload()
    await pause(1500)
    const persisted = await main.webContents.executeJavaScript(
      `document.querySelector('select[aria-label="考试平台"]')?.value`
    )
    assert.equal(persisted, 'iguokao')
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelector('input[aria-label="显示截图缩略图"]').checked`
      ),
      true
    )
    assert.deepEqual(errors, [])
    const output = process.env.UI_SMOKE_SCREENSHOT
    if (output) writeFileSync(output, (await main.webContents.capturePage()).toPNG())

    // Workbench answer surfaces must be transparent and both themes readable.
    main.hide()
    await main.webContents.executeJavaScript("window.location.hash='/'")
    await pause(400)
    for (const [theme, expectedColor] of [
      ['light', 'rgb(24, 24, 27)'],
      ['dark', 'rgb(245, 245, 245)']
    ]) {
      main.webContents.send('background-theme', theme)
      await pause(100)
      const appearance = await main.webContents.executeJavaScript(`({
        textOnly:!!document.querySelector('.text-only-mode'),
        background:getComputedStyle(document.getElementById('app-content')).backgroundColor,
        color:getComputedStyle(document.getElementById('app-content')).color
      })`)
      assert.equal(appearance.textOnly, true)
      assert.equal(appearance.background, 'rgba(0, 0, 0, 0)')
      assert.equal(appearance.color, expectedColor)
    }
    await main.webContents.executeJavaScript("window.location.hash='/settings'")
    await pause(200)
    await main.webContents.executeJavaScript(
      `document.querySelector('input[aria-label="纯文字答案"]').click()`
    )
    await pause(100)
    await main.webContents.executeJavaScript("window.location.hash='/'")
    await pause(200)
    const panelRestored = await main.webContents.executeJavaScript(`({
      enabled:!!document.querySelector('.text-only-mode'),
      background:getComputedStyle(document.getElementById('app-content')).backgroundColor
    })`)
    assert.equal(panelRestored.enabled, false)
    assert.notEqual(panelRestored.background, 'rgba(0, 0, 0, 0)')

    // Exercise the emitted worker in Electron, including ASAR loading when supplied.
    const workerName = readdirSync(join(__dirname, '../out/main')).find((name) =>
      /^image-worker-.*\.js$/.test(name)
    )
    assert.ok(workerName)
    const workerRoot = process.env.SMOKE_WORKER_ASAR || join(__dirname, '..')
    const workerPath = join(workerRoot, 'out/main', workerName)
    assert.ok(existsSync(workerPath))
    const worker = new Worker(workerPath)
    try {
      const encoded = new Promise((resolve, reject) => {
        worker.once('message', resolve)
        worker.once('error', reject)
        worker.once('exit', (code) => {
          if (code !== 0) reject(new Error(`Worker exit ${code}`))
        })
      })
      const pixels = new Uint8Array(1920 * 1080 * 4).fill(200)
      worker.postMessage(
        {
          id: 1,
          job: {
            kind: 'encode',
            preview: false,
            frame: { pixels, width: 1920, height: 1080, stride: 7680 }
          }
        },
        [pixels.buffer]
      )
      const response = await encoded
      assert.equal(response.result?.kind, 'encoded', response.error)
      assert.equal(response.result.preview, '')
      assert.ok(response.result.image.startsWith('iVBORw0KGgo'))
    } finally {
      await worker.terminate()
    }
    console.log(
      JSON.stringify({
        ok: true,
        platform: persisted,
        settings: true,
        fallback: true,
        previewSetting: true,
        transparentAnswers: true,
        contrastingThemes: true,
        imageWorker: true,
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
