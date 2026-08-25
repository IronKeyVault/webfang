# Kigger en MP4 efter i sømmene uden at læse den ind i hukommelsen.
#
# Brug:  powershell -ExecutionPolicy Bypass -File inspect-mp4.ps1 "C:\sti\til\film.mp4"
#
# Formålet er at afgøre om en samlet fil er hel: har den både et video- og et
# lydspor, og peger sporenes chunk-offsets ned i filens mediedata? Et offset
# der peger uden for mdat er den klassiske fejl efter en ompakning – filen har
# alle sine bytes og er alligevel ubrugelig.

param([Parameter(Mandatory = $true)][string]$Path)

if (-not (Test-Path $Path)) { Write-Error "Findes ikke: $Path"; exit 1 }

$fs = [System.IO.File]::OpenRead($Path)
$len = $fs.Length
Write-Host "Fil: $Path"
Write-Host ("Størrelse: {0:N0} bytes ({1:N1} MB)" -f $len, ($len / 1MB))

function Read-Bytes([long]$at, [int]$n) {
  $fs.Position = $at
  $buf = New-Object byte[] $n
  $read = 0
  while ($read -lt $n) {
    $got = $fs.Read($buf, $read, $n - $read)
    if ($got -le 0) { break }
    $read += $got
  }
  return $buf
}

function BE32([byte[]]$b, [int]$o) {
  return [uint32]$b[$o] * 16777216 + [uint32]$b[$o+1] * 65536 + [uint32]$b[$o+2] * 256 + [uint32]$b[$o+3]
}

function BE64([byte[]]$b, [int]$o) {
  return [double](BE32 $b $o) * 4294967296 + [double](BE32 $b ($o + 4))
}

function Type4([byte[]]$b, [int]$o) {
  return [System.Text.Encoding]::ASCII.GetString($b, $o, 4)
}

# ---- Øverste niveau --------------------------------------------------------

Write-Host "`nBokse på øverste niveau:"
$off = [long]0
$mdatStart = [long]-1
$mdatEnd = [long]-1
$moovAt = [long]-1
$moovSize = [long]0

while ($off + 8 -le $len) {
  $h = Read-Bytes $off 16
  if ($h.Length -lt 8) { break }
  $size = [double](BE32 $h 0)
  $type = Type4 $h 4
  $header = 8
  if ($size -eq 1) { $size = BE64 $h 8; $header = 16 }
  elseif ($size -eq 0) { $size = $len - $off }
  if ($size -lt $header) { Write-Host "  ØDELAGT boks '$type' med størrelse $size ved $off"; break }

  Write-Host ("  {0}  ved {1,14:N0}  {2,16:N0} bytes" -f $type, $off, $size)
  if ($type -eq 'mdat') { $mdatStart = $off + $header; $mdatEnd = $off + $size }
  if ($type -eq 'moov') { $moovAt = $off; $moovSize = $size }
  $off += [long]$size
}

if ($off -ne $len) {
  Write-Host ("  ADVARSEL: bokse dækker {0:N0} bytes, men filen er {1:N0} — {2:N0} bytes hænger løst i enden." -f $off, $len, ($len - $off))
} else {
  Write-Host "  Boksene dækker filen præcist."
}

if ($moovAt -lt 0) { Write-Host "`nIngen moov — filen har ingen indholdsfortegnelse og kan ikke afspilles."; $fs.Close(); exit 1 }

# ---- Sporene ---------------------------------------------------------------

$moov = Read-Bytes $moovAt ([int]$moovSize)

# Rå gennemsøgning: god nok til en diagnose, og uafhængig af boks-hierarkiet.
$traks = @()
for ($i = 0; $i -lt $moov.Length - 8; $i++) {
  $t = Type4 $moov $i
  if ($t -eq 'hdlr') {
    $handler = Type4 $moov ($i + 16)
    $traks += [pscustomobject]@{ At = $i; Handler = $handler }
  }
}

Write-Host "`nSpor:"
if ($traks.Count -eq 0) { Write-Host "  ingen fundet" }
foreach ($t in $traks) {
  $name = switch ($t.Handler) { 'vide' { 'video' } 'soun' { 'lyd' } default { $t.Handler } }
  Write-Host "  $name"
}

# ---- Chunk-offsets ---------------------------------------------------------

Write-Host "`nChunk-offsets (peger de ned i mediedata?):"
$tabIndex = 0
for ($i = 0; $i -lt $moov.Length - 8; $i++) {
  $t = Type4 $moov ($i + 4)
  if ($t -ne 'stco' -and $t -ne 'co64') { continue }
  $tabIndex++
  $count = BE32 $moov ($i + 12)
  if ($count -eq 0 -or $count -gt 20000000) { continue }

  $first = if ($t -eq 'stco') { [double](BE32 $moov ($i + 16)) } else { BE64 $moov ($i + 16) }
  $lastAt = if ($t -eq 'stco') { $i + 16 + ($count - 1) * 4 } else { $i + 16 + ($count - 1) * 8 }
  if ($lastAt + 8 -gt $moov.Length) { continue }
  $last = if ($t -eq 'stco') { [double](BE32 $moov $lastAt) } else { BE64 $moov $lastAt }

  $inside = ($first -ge $mdatStart -and $last -lt $mdatEnd)
  $verdict = if ($mdatStart -lt 0) { 'intet mdat at holde dem op mod' }
             elseif ($inside) { 'OK — inden for mdat' }
             else { 'FEJL — peger uden for mdat' }

  Write-Host ("  tabel {0} ({1}, {2:N0} chunks): første {3:N0}, sidste {4:N0}  → {5}" -f `
    $tabIndex, $t, $count, $first, $last, $verdict)

  # Er sidste chunk overhovedet inde i filen?
  if ($last -ge $len) {
    Write-Host ("     sidste chunk ligger {0:N0} bytes efter filens slutning — filen er afkortet." -f ($last - $len))
  }
}

if ($mdatStart -ge 0) {
  Write-Host ("`nmdat: bytes {0:N0} til {1:N0} ({2:N1} MB mediedata)" -f $mdatStart, $mdatEnd, (($mdatEnd - $mdatStart) / 1MB))
}

$fs.Close()
