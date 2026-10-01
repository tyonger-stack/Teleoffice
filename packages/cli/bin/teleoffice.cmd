@echo off
rem teleoffice launcher for the packaged Windows app: <install>\resources\cli\teleoffice.cmd
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\GenOffice.exe" "%~dp0teleoffice.cjs" %*
endlocal
