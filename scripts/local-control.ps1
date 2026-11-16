$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $ScriptDir "service.mjs") @args
exit $LASTEXITCODE
