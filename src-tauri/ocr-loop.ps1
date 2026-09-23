# Resident Windows OCR. One image path per stdin line, one "OK <base64>" line back.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapPixelFormat, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapAlphaMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Media.Ocr, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await([object]$WinRtTask, [type]$ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) {
  $lang = New-Object Windows.Globalization.Language 'zh-Hans'
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
}
if ($null -eq $engine) {
  [Console]::Out.WriteLine('ERR')
  [Console]::Out.Flush()
  exit 1
}

[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()

while ($true) {
  $path = [Console]::In.ReadLine()
  if ($null -eq $path) { break }
  $path = $path.Trim()
  if ($path.Length -eq 0) { continue }
  $payload = '-'
  try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $bitmap = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert(
      $bitmap,
      [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
      [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied
    )
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($line in $result.Lines) {
      if ($null -ne $line.Text) {
        $piece = $line.Text.Trim()
        if ($piece.Length -gt 0) { $parts.Add($piece) }
      }
    }
    $text = $parts -join "`n"
    if ($text.Length -gt 0) {
      $payload = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($text))
    }
  } catch {
    $payload = '-'
  }
  [Console]::Out.WriteLine("OK $payload")
  [Console]::Out.Flush()
}
