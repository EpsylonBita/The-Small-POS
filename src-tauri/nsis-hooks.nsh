; Custom NSIS hooks for The Small POS
; Called by Tauri's auto-generated installer.nsi via !ifmacrodef checks.

; NSIS_HOOK_POSTUNINSTALL — runs after files, registry keys, and shortcuts
; have been removed. We use it to clean up Windows Credential Manager entries
; left behind by the keyring crate (service: "the-small-pos").
;
; keyring v3 stores credentials with target = "{service}.{user}" on Windows,
; so we enumerate and delete any credential whose target starts with
; "the-small-pos." to ensure a clean uninstall.
!macro NSIS_HOOK_POSTUNINSTALL
  ; Only clean credentials when the user opted to delete app data
  ; and we are NOT in update mode (updates should preserve credentials).
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; Use PowerShell to remove all Windows Credential Manager entries
    ; whose target starts with "the-small-pos."
    nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -Command "& { try { $targets = @(\"the-small-pos.admin_dashboard_url\", \"the-small-pos.terminal_id\", \"the-small-pos.pos_api_key\", \"the-small-pos.branch_id\", \"the-small-pos.organization_id\", \"the-small-pos.business_type\", \"the-small-pos.supabase_url\", \"the-small-pos.supabase_anon_key\", \"the-small-pos.ghost_mode_feature_enabled\"); foreach ($$t in $$targets) { cmdkey /delete:$$t 2>$$null } } catch {} }"'
  ${EndIf}
!macroend
