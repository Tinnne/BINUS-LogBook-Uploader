@echo off
rem Packages the extension for both browsers from the shared source.
rem   firefox\ -> .xpi | chrome\ -> .zip  (PowerShell Compress-Archive, Win10+)
setlocal
cd /d "%~dp0\.."

set "XPI=dist\firefox\binus-logbook-uploader.xpi"
set "ZIP=dist\chrome\binus-logbook-uploader.zip"

if exist "%XPI%" del "%XPI%"
if exist "%ZIP%" del "%ZIP%"

rem Guard: on Windows without Developer Mode, git symlinks check out as tiny
rem stub text files; packaging those would ship a broken content.js.
powershell -NoProfile -Command "if ((Get-Item 'firefox\extension\content.js').Length -lt 1000) { throw 'firefox\extension\content.js is a stub - git symlinks not materialized. Enable Windows Developer Mode, set git config core.symlinks true, re-checkout (git checkout -- .), then retry.' }"
if errorlevel 1 exit /b 1

rem Compress-Archive dereferences real symlinks: shared\content.js lands as a real file.
rem Note: ';' separators - '&&' does not exist in Windows PowerShell 5.
powershell -NoProfile -Command "Compress-Archive -Path 'firefox\extension\*' -DestinationPath '%XPI%'; Compress-Archive -Path 'chrome\*' -DestinationPath '%ZIP%'; Get-Item '%XPI%','%ZIP%' | Select-Object Name,Length"
if errorlevel 1 (
    echo Packaging failed. >&2
    exit /b 1
)