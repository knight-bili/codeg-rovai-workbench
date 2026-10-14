param(
    [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$taskRepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$taskMatrix = Get-Content -LiteralPath (Join-Path $taskRepoRoot 'integration/planning/runtime-matrix.json') -Raw | ConvertFrom-Json
$taskAliases = @{
    antigravity = @('agy'); claude_code = @('claude'); cline = @('cline')
    code_buddy = @('codebuddy'); codex = @('codex'); command_code = @('command-code', 'cmdc')
    copilot = @('copilot'); cursor = @('cursor-agent', 'agent'); deepseek = @('dsh')
    gemini = @('gemini'); grok = @('grok'); hermes = @('hermes'); kimi_code = @('kimi')
    kiro = @('kiro-cli'); open_claw = @('openclaw'); open_code = @('opencode')
    pi = @('pi'); qoder = @('qodercli'); qwen_code = @('qwen'); trae_cn = @('traecli'); zcode = @('ZCode')
}
if ($taskMatrix.runtimes.Count -ne 21 -or $taskAliases.Count -ne 21) { throw 'Runtime matrix/alias coverage changed; review source mapping.' }
$taskRows = foreach ($taskRuntime in $taskMatrix.runtimes) {
    if (-not $taskAliases.ContainsKey($taskRuntime.id)) { throw "Missing source alias: $($taskRuntime.id)" }
    $taskEntries = @(foreach ($taskAlias in $taskAliases[$taskRuntime.id]) {
        $taskResolved = Get-Command -Name $taskAlias -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($taskResolved) { [ordered]@{ alias = $taskAlias; path = $taskResolved.Source; commandType = [string]$taskResolved.CommandType } }
    })
    [ordered]@{
        id = $taskRuntime.id; sources = @($taskRuntime.sources); aliases = @($taskAliases[$taskRuntime.id])
        pathDiscovery = if ($taskEntries.Count) { 'found_on_current_path' } else { 'not_found_on_current_path' }
        executables = $taskEntries; coreAdmission = 'not_run'; authentication = 'not_checked'; actualInference = 'not_run'
    }
}
$taskResult = [ordered]@{
    schema_version = 1; checkedAt = [DateTime]::UtcNow.ToString('o'); task = 'I02-T02'; platform = 'windows'
    scope = 'read_only_current_process_PATH_inventory'; sourceCoverage = $taskRows.Count
    foundCount = @($taskRows | Where-Object { $_.pathDiscovery -eq 'found_on_current_path' }).Count
    runtimes = @($taskRows)
    limits = @('PATH absence does not establish uninstalled status', 'No install, login, global configuration or model turn is performed', 'An alias is not an admitted adapter; product/version/integrity still require Core probing', 'macOS/Linux discovery and all execution tests remain not_run')
    sourceMappings = @('crates/rovai-core/src/agent_profile.rs:174', 'Codeg fixed source src-tauri/src/acp/registry.rs Gemini/OpenClaw/Hermes entries')
}
$taskAbsoluteOutput = [IO.Path]::GetFullPath($OutputPath)
$taskResult | ConvertTo-Json -Depth 9 | Set-Content -LiteralPath $taskAbsoluteOutput -Encoding utf8
[ordered]@{ status = 'inventory_saved'; total = $taskRows.Count; found = $taskResult.foundCount; output = $taskAbsoluteOutput } | ConvertTo-Json -Compress
