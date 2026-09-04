Unicode true
Name "Managed credential cleanup smoke"
OutFile "managed-credential-cleanup-smoke.exe"
RequestExecutionLevel user

!include "LogicLib.nsh"
!define MAINBINARYNAME "the-small-pos"
!include "..\..\src-tauri\nsis-hooks.nsh"

Var DeleteAppDataCheckboxState
Var UpdateMode
Var PassiveMode

Section
  WriteUninstaller "$TEMP\managed-credential-cleanup-smoke-uninstall.exe"
SectionEnd

Section "Uninstall"
  StrCpy $DeleteAppDataCheckboxState 1
  StrCpy $UpdateMode 0
  !insertmacro NSIS_HOOK_POSTUNINSTALL
SectionEnd
