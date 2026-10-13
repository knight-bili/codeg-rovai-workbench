param(
    [Parameter(Mandatory = $true)][string]$FixtureRoot,
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
$fixture = [System.IO.Path]::GetFullPath($FixtureRoot).TrimEnd('\') + '\'
$sourcePath = (Resolve-Path -LiteralPath $Source).Path.TrimEnd('\')
$destinationPath = (Resolve-Path -LiteralPath $Destination).Path.TrimEnd('\')
foreach ($target in @($sourcePath, $destinationPath)) {
    if (-not $target.StartsWith($fixture, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'ACL copying is restricted to this newly created fixture'
    }
}
# 只对本次已复制的目录树保留权限，不修复或放宽任何未知数据根。
$items = @(Get-Item -LiteralPath $sourcePath) + @(Get-ChildItem -LiteralPath $sourcePath -Force -Recurse)
foreach ($item in $items) {
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw 'Linked fixture entries are not admitted'
    }
    $relative = $item.FullName.Substring($sourcePath.Length).TrimStart('\')
    $target = if ($relative) { Join-Path $destinationPath $relative } else { $destinationPath }
    Set-Acl -LiteralPath $target -AclObject (Get-Acl -LiteralPath $item.FullName)
}
