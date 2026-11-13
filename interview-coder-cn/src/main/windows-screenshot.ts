import { execFile } from 'node:child_process'
import { join } from 'node:path'

export interface WindowsScreenshot {
  image: string
  preview: string
  captureMs: number
  resizeMs: number
  encodeMs: number
  previewMs: number
}

// Capture and encode outside Electron's UI thread. No image files are written.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('CaptureDpi'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$module = $assembly.DefineDynamicModule('CaptureDpi')
$type = $module.DefineType('CaptureDpi', [Reflection.TypeAttributes]'Public, Abstract, Sealed')
$method = $type.DefinePInvokeMethod('SetProcessDPIAware', 'user32.dll', [Reflection.MethodAttributes]'Public, Static, PinvokeImpl', [Reflection.CallingConventions]::Standard, [bool], [Type[]]@(), [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Auto)
$method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
$nativeType = $type.CreateType()
$nativeType.GetMethod('SetProcessDPIAware').Invoke($null, $null) | Out-Null
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$source = $null
$sourceGraphics = $null
$image = $null
$imageGraphics = $null
$preview = $null
$previewGraphics = $null
$imageStream = $null
$previewStream = $null
try {
  $source = [System.Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
  $sourceGraphics = [System.Drawing.Graphics]::FromImage($source)
  $start = $clock.ElapsedMilliseconds
  $sourceGraphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $captureMs = $clock.ElapsedMilliseconds - $start

  $start = $clock.ElapsedMilliseconds
  $image = [System.Drawing.Bitmap]::new(__WIDTH__, __HEIGHT__)
  $imageGraphics = [System.Drawing.Graphics]::FromImage($image)
  $imageGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $imageGraphics.DrawImage($source, 0, 0, __WIDTH__, __HEIGHT__)
  $resizeMs = $clock.ElapsedMilliseconds - $start

  $start = $clock.ElapsedMilliseconds
  $imageStream = [System.IO.MemoryStream]::new()
  $image.Save($imageStream, [System.Drawing.Imaging.ImageFormat]::Png)
  $imageData = [Convert]::ToBase64String($imageStream.ToArray())
  $encodeMs = $clock.ElapsedMilliseconds - $start

  $start = $clock.ElapsedMilliseconds
  $previewWidth = [Math]::Min(640, __WIDTH__)
  $previewHeight = [Math]::Max(1, [int][Math]::Round(__HEIGHT__ * $previewWidth / __WIDTH__))
  $preview = [System.Drawing.Bitmap]::new($previewWidth, $previewHeight)
  $previewGraphics = [System.Drawing.Graphics]::FromImage($preview)
  $previewGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $previewGraphics.DrawImage($image, 0, 0, $previewWidth, $previewHeight)
  $previewStream = [System.IO.MemoryStream]::new()
  $preview.Save($previewStream, [System.Drawing.Imaging.ImageFormat]::Png)
  $previewData = [Convert]::ToBase64String($previewStream.ToArray())
  $previewMs = $clock.ElapsedMilliseconds - $start

  [Console]::Out.Write((@{
    image = $imageData; preview = $previewData
    captureMs = $captureMs; resizeMs = $resizeMs
    encodeMs = $encodeMs; previewMs = $previewMs
  } | ConvertTo-Json -Compress))
} finally {
  foreach ($item in @($previewStream, $imageStream, $previewGraphics, $preview, $imageGraphics, $image, $sourceGraphics, $source)) {
    if ($null -ne $item) { $item.Dispose() }
  }
}
`

export function takeWindowsScreenshot(width: number, height: number): Promise<WindowsScreenshot> {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 32768 ||
    height > 32768
  ) {
    return Promise.reject(new Error('Invalid screenshot dimensions'))
  }
  const script = SCRIPT.replaceAll('__WIDTH__', String(width)).replaceAll(
    '__HEIGHT__',
    String(height)
  )
  const executable = join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')
      ],
      { windowsHide: true, timeout: 15000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          reject(new Error(`Windows screenshot process failed: ${error.code ?? error.name}`))
          return
        }
        try {
          const result = JSON.parse(stdout.trim()) as WindowsScreenshot
          if (
            !result.image?.startsWith('iVBORw0KGgo') ||
            !result.preview?.startsWith('iVBORw0KGgo')
          ) {
            throw new Error('Missing PNG output')
          }
          resolve(result)
        } catch {
          reject(new Error('Windows screenshot process returned invalid image data'))
        }
      }
    )
  })
}
