$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$sampleRoot = Join-Path $repoRoot "models/local-speech-benchmark/tts-samples"

# Compare the production split (sherpa-split) with one Telugu voice per line,
# plus each Telugu candidate through both runtimes and both English samples.
$samples = @(
    "sherpa-split/te.wav",
    "sherpa-split/en.wav",
    "sherpa-split/mix.wav",
    "sherpa-split/mix-translit.wav",
    "sherpa-piper-te_IN-venkatesh-medium/te.wav",
    "sherpa-piper-te_IN-venkatesh-medium/mix.wav",
    "sherpa-piper-te_IN-venkatesh-medium/mix-translit.wav",
    "sherpa-piper-te_IN-maya-medium/te.wav",
    "sherpa-piper-te_IN-maya-medium/mix.wav",
    "sherpa-piper-te_IN-maya-medium/mix-translit.wav",
    "sherpa-piper-te_IN-padmavathi-medium/te.wav",
    "sherpa-piper-te_IN-padmavathi-medium/mix.wav",
    "sherpa-piper-te_IN-padmavathi-medium/mix-translit.wav",
    "sherpa-piper-en_US-joe-medium/en.wav",
    "piper-te_IN-venkatesh-medium/te.wav",
    "piper-te_IN-venkatesh-medium/mix.wav",
    "piper-te_IN-venkatesh-medium/mix-translit.wav",
    "piper-te_IN-maya-medium/te.wav",
    "piper-te_IN-maya-medium/mix.wav",
    "piper-te_IN-maya-medium/mix-translit.wav",
    "piper-te_IN-padmavathi-medium/te.wav",
    "piper-te_IN-padmavathi-medium/mix.wav",
    "piper-te_IN-padmavathi-medium/mix-translit.wav",
    "piper-en_US-joe-medium/en.wav"
)

foreach ($relativePath in $samples) {
    $path = Join-Path $sampleRoot $relativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required benchmark sample is missing: $path"
    }

    Write-Host "`n$relativePath"
    Write-Host "Listen for pronunciation, naturalness and voice changes. Press Enter to play; Ctrl+C to stop."
    [void](Read-Host)
    $player = New-Object -TypeName System.Media.SoundPlayer -ArgumentList $path
    $player.Load()
    $player.PlaySync()
    $player.Dispose()
}

Write-Host "`nFinished. These samples have not been human-reviewed until you assess them."
