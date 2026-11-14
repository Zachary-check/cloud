/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, ipcMain } = require('electron')
const { PNG } = require('pngjs')
const { mkdtempSync, writeFileSync, readdirSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const assert = require('node:assert/strict')
const { Worker } = require('node:worker_threads')
const expectedToolbarOpacity = process.platform === 'win32' ? 0.8 : 1

const toolbarWrites = []
const toolbarVisibility = []
const registerHandler = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, handler) =>
  registerHandler(channel, (event, ...args) => {
    if (channel === 'updateAppSettings' || channel === 'initShortcuts')
      toolbarWrites.push(event.sender.id)
    if (channel === 'setToolbarVisible')
      toolbarVisibility.push({ sender: event.sender.id, visible: args[0] })
    return handler(event, ...args)
  })

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
      previews:document.querySelector('input[aria-label="显示截图缩略图"]')?.checked,
      compatibility:document.querySelector('input[aria-label="2.2.0 显示兼容模式"]')?.checked,
      textOnlyDisabled:document.querySelector('input[aria-label="纯文字答案"]')?.disabled
    })`)
    assert.ok(initial.text.includes('截图与客户端兼容'))
    assert.ok(initial.text.includes('v' + require('../package.json').version))
    assert.ok(initial.text.includes('API Base URL'))
    assert.ok(initial.text.includes('备用'))
    assert.equal(initial.platform, 'auto')
    if (process.platform !== 'win32') assert.equal(initial.nativeDisabled, true)
    assert.equal(initial.textOnly, true)
    assert.equal(initial.previews, false)
    assert.equal(initial.compatibility, true)
    assert.equal(initial.textOnlyDisabled, true)
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

    const toolbar = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().includes('toolbar')
    )
    assert.ok(toolbar)
    await main.webContents.executeJavaScript("window.location.hash='/'")
    await pause(400)
    const compatibleAnswer = await main.webContents.executeJavaScript(`({
      textOnly:!!document.querySelector('.text-only-mode'),
      background:getComputedStyle(document.getElementById('app-content')).backgroundColor,
      headerBackground:getComputedStyle(document.getElementById('app-header')).backgroundColor,
      bodyOpacity:getComputedStyle(document.body).opacity
    })`)
    const compatibleToolbar = await toolbar.webContents.executeJavaScript(`({
      textOnly:!!document.querySelector('.text-only-mode'),
      background:getComputedStyle(document.querySelector('.overlay-toolbar')).backgroundColor,
      color:getComputedStyle(document.querySelector('.overlay-toolbar button')).color,
      bodyOpacity:getComputedStyle(document.body).opacity
    })`)
    // Measured from the delivered 2.2.0 app.asar with fresh settings, not a recreated window.
    const reference = require('./fixtures/window-2.2.0-reference.json')
    assert.deepEqual(compatibleAnswer, reference.answer)
    assert.deepEqual(compatibleToolbar, reference.toolbar)
    console.log(JSON.stringify({ panelCompatibility: true, compatibleAnswer, compatibleToolbar }))
    await main.webContents.executeJavaScript("window.location.hash='/settings'")
    await pause(200)
    await main.webContents.executeJavaScript(
      `document.querySelector('input[aria-label="2.2.0 显示兼容模式"]').click()`
    )
    await pause(150)
    main.webContents.reload()
    await pause(1000)
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelector('input[aria-label="2.2.0 显示兼容模式"]').checked`
      ),
      false
    )

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

    const toolbarStyle = () =>
      toolbar.webContents.executeJavaScript(`({
      background:getComputedStyle(document.querySelector('.overlay-toolbar')).backgroundColor,
      color:getComputedStyle(document.querySelector('.overlay-toolbar button')).color,
      bodyOpacity:getComputedStyle(document.body).opacity,
      icons:[...document.querySelectorAll('.overlay-toolbar svg')].length,
      iconOpacity:getComputedStyle(document.querySelector('.overlay-toolbar svg')).opacity
    })`)
    assert.notEqual((await toolbarStyle()).background, 'rgba(0, 0, 0, 0)')
    await main.webContents.executeJavaScript(`window.api.updateAppSettings({textOnlyAnswers:true})`)
    await pause(150)
    assert.equal((await toolbarStyle()).background, 'rgba(0, 0, 0, 0)')
    for (const [theme, color] of [
      ['light', 'rgb(24, 24, 27)'],
      ['dark', 'rgb(245, 245, 245)']
    ]) {
      toolbar.webContents.send('background-theme', theme)
      await pause(100)
      assert.equal((await toolbarStyle()).color, color)
    }
    // Legacy URLs must not allow the independent toolbar store to overwrite settings.
    await toolbar.loadFile(join(__dirname, '../out/renderer/index.html'), { hash: 'toolbar' })
    await pause(400)
    assert.equal(toolbarWrites.filter((id) => id === toolbar.webContents.id).length, 0)
    for (let i = 0; i < 10; i++)
      await main.webContents.executeJavaScript(
        `window.api.updateAppSettings({opacity:0.1,textOnlyAnswers:true,toolbarHoverDelay:1000,workMode:'written'})`
      )
    main.showInactive()
    main.blur()
    await pause(6500)
    assert.ok(Math.abs(toolbar.getOpacity() - expectedToolbarOpacity) < 0.0001)
    const idleStyle = await toolbarStyle()
    assert.equal(idleStyle.bodyOpacity, '1')
    assert.equal(idleStyle.iconOpacity, '1')
    assert.ok(idleStyle.icons >= 4)
    const toolbarImage = (await toolbar.webContents.capturePage()).toPNG()
    if (process.env.UI_SMOKE_TOOLBAR_SCREENSHOT)
      writeFileSync(process.env.UI_SMOKE_TOOLBAR_SCREENSHOT, toolbarImage)
    const pixels = PNG.sync.read(toolbarImage).data
    let visiblePixels = 0
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) visiblePixels++
    console.log(
      JSON.stringify({
        toolbarVisible: toolbar.isVisible(),
        mainVisible: main.isVisible(),
        toolbarBounds: toolbar.getBounds(),
        idleStyle,
        visiblePixels,
        toolbarVisibility
      })
    )
    assert.ok(visiblePixels > 40, 'toolbar icons must still be painted after idle')
    main.focus()
    await pause(150)
    main.blur()
    await pause(2200)
    assert.ok(Math.abs(toolbar.getOpacity() - expectedToolbarOpacity) < 0.0001)
    assert.equal((await toolbarStyle()).iconOpacity, '1')
    // Restore the compatibility default for the native Windows observations.
    await main.webContents.executeJavaScript("window.location.hash='/settings'")
    await pause(200)
    await main.webContents.executeJavaScript(
      `document.querySelector('input[aria-label="2.2.0 显示兼容模式"]').click()`
    )
    await pause(150)
    await main.webContents.executeJavaScript("window.location.hash='/'")
    await pause(200)
    assert.notEqual((await toolbarStyle()).background, 'rgba(0, 0, 0, 0)')
    if (process.platform === 'win32') {
      const inspect = require('./windows-window-state.cjs')
      const legacy = new BrowserWindow({
        width: 404,
        height: 44,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        focusable: false,
        parent: main,
        show: false
      })
      const opaque = new BrowserWindow({
        width: 404,
        height: 44,
        frame: false,
        transparent: true,
        opacity: 1,
        alwaysOnTop: true,
        focusable: false,
        parent: main,
        show: false
      })
      const competitor = new BrowserWindow({
        width: 1100,
        height: 800,
        frame: false,
        alwaysOnTop: true,
        show: false
      })
      try {
        legacy.setOpacity(0.8)
        legacy.setIgnoreMouseEvents(true, { forward: true })
        opaque.setIgnoreMouseEvents(true, { forward: true })
        competitor.setTitle('普通窗口 · 层级检查')
        const bounds = main.getBounds()
        competitor.setBounds({
          x: bounds.x - 10,
          y: bounds.y - 60,
          width: bounds.width + 20,
          height: bounds.height + 100
        })
        competitor.show()
        competitor.focus()
        competitor.setAlwaysOnTop(true, 'screen-saver', 100)
        competitor.moveTop()
        await pause(1000)
        const unrelated = inspect({ main, toolbar, competitor })
        assert.ok(
          unrelated.competitor.z < unrelated.main.z,
          'unrelated windows must not trigger recovery'
        )
        competitor.setTitle('国考云 · 登录窗口模拟')
        competitor.setPosition(bounds.x - 8, bounds.y - 58)
        // A drag can reorder two topmost windows without clearing either flag.
        const covered = inspect({ main, toolbar, competitor })
        assert.equal(covered.main.topmost, true)
        assert.equal(covered.toolbar.topmost, true)
        assert.ok(covered.competitor.z < covered.main.z)
        assert.equal(covered.competitor.foreground, true)
        await pause(2100)
        const recovered = inspect({ main, toolbar, competitor })
        assert.ok(
          recovered.main.z < recovered.competitor.z,
          'covered main must recover automatically'
        )
        assert.ok(recovered.toolbar.z < recovered.main.z, 'toolbar must recover with its owner')
        assert.equal(recovered.competitor.foreground, true, 'recovery must not steal typing focus')
        console.log(JSON.stringify({ movedWindowRecovery: true, covered, recovered }))
        // A second reorder must be recoverable by the existing explicit action too.
        competitor.moveTop()
        // The existing explicit recovery action must repair the whole pair.
        app.emit('second-instance')
        await pause(200)
        const states = inspect({ main, toolbar, legacy, opaque, competitor })
        assert.equal(states.toolbar.layered, true)
        assert.equal(states.toolbar.hasAlpha, true)
        assert.equal(states.legacy.hasAlpha, true)
        assert.equal(states.toolbar.flags & 2, 2)
        assert.equal(states.toolbar.flags & 2, states.legacy.flags & 2)
        assert.equal(states.toolbar.alpha, states.legacy.alpha)
        assert.equal(states.toolbar.alpha, 204)
        assert.equal(states.main.topmost, true)
        assert.equal(states.toolbar.topmost, true)
        assert.ok(states.main.z >= 0 && states.toolbar.z >= 0 && states.competitor.z >= 0)
        assert.ok(
          states.main.z < states.competitor.z,
          'main window must recover above the other topmost test window'
        )
        assert.ok(states.toolbar.z < states.main.z, 'toolbar must recover above its owner')
        console.log(JSON.stringify({ windowsDisplayCompatibility: true, states }))
      } finally {
        competitor.destroy()
        legacy.destroy()
        opaque.destroy()
      }
    }
    main.hide()

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
        panelCompatibility: true,
        compatibilityPersistence: true,
        fallback: true,
        previewSetting: true,
        transparentAnswers: true,
        contrastingThemes: true,
        imageWorker: true,
        transparentToolbar: true,
        toolbarReadOnly: true,
        toolbarIconsAfterIdle: true,
        windowsDisplayCompatibility: process.platform === 'win32',
        movedWindowRecovery: process.platform === 'win32',
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
