; Custom NSIS hooks for The Small POS
; Called by Tauri's auto-generated installer.nsi via !ifmacrodef checks.

!define CALLER_ID_FIREWALL_RULE "The Small POS Caller ID (Private LAN)"
; Capture this directory while the hook file itself is included. Evaluating
; __FILEDIR__ inside a hook macro would resolve to Tauri's generated installer.
!define CALLER_ID_FIREWALL_HELPER "${__FILEDIR__}\caller-id-firewall.ps1"

; A normal interactive install asks before changing firewall state. The Tauri
; updater runs as /P /UPDATE, so it only narrows a compatible active Public app
; grant whose constraints prove the replacement is no broader; it never creates
; a first-time inbound grant on an unrelated installation.
!macro NSIS_HOOK_POSTINSTALL
  InitPluginsDir
  File /oname=$PLUGINSDIR\caller-id-firewall.ps1 "${CALLER_ID_FIREWALL_HELPER}"

  IfSilent caller_id_firewall_update_migration
  ${If} $PassiveMode = 1
    Goto caller_id_firewall_update_migration
  ${EndIf}
  ${If} $UpdateMode = 1
    Goto caller_id_firewall_update_migration
  ${EndIf}

  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON1 "Enable Caller ID on this trusted store's Private network?$\r$\n$\r$\nYes removes old Public access and allows only local UDP 5060. No makes no network changes.$\r$\n$\r$\nΝα ενεργοποιηθεί η αναγνώριση κλήσεων στο Ιδιωτικό δίκτυο του καταστήματος;$\r$\n$\r$\nΤο Ναι αφαιρεί την παλιά Δημόσια πρόσβαση και επιτρέπει μόνο τοπικό UDP 5060. Το Όχι δεν αλλάζει το δίκτυο." IDNO caller_id_firewall_done
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\caller-id-firewall.ps1" -Action Install -ExecutablePath "$INSTDIR\${MAINBINARYNAME}.exe"'
  Pop $0
  ${If} $0 <> 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "The POS was installed, but Windows could not enable Private-network access for Caller ID.$\r$\n$\r$\nΤο POS εγκαταστάθηκε, αλλά τα Windows δεν μπόρεσαν να ενεργοποιήσουν την πρόσβαση Ιδιωτικού δικτύου για την αναγνώριση κλήσεων."
  ${EndIf}
  Goto caller_id_firewall_done

caller_id_firewall_update_migration:
  ${If} $UpdateMode <> 1
    Goto caller_id_firewall_done
  ${EndIf}
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\caller-id-firewall.ps1" -Action MigrateLegacyPublic -ExecutablePath "$INSTDIR\${MAINBINARYNAME}.exe"'
  Pop $0

caller_id_firewall_done:
!macroend

; NSIS_HOOK_POSTUNINSTALL — runs after files, registry keys, and shortcuts
; have been removed. We use it to clean up Windows Credential Manager entries
; left behind by the keyring crate (service: "the-small-pos").
;
; keyring v3 stores credentials with target = "{service}.{user}" on Windows,
; so we enumerate and delete any credential whose target starts with
; "the-small-pos." to ensure a clean uninstall.
!macro NSIS_HOOK_POSTUNINSTALL
  ; A real uninstall removes the installer-owned network grant. Updater
  ; uninstall keeps it so an already-approved manual install remains working.
  ${If} $UpdateMode <> 1
    nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${CALLER_ID_FIREWALL_RULE}"'
    Pop $0
  ${EndIf}

  ; Only clean credentials when the user opted to delete app data
  ; and we are NOT in update mode (updates should preserve credentials).
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; Use PowerShell to remove all Windows Credential Manager entries
    ; whose target starts with "the-small-pos."
    nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -Command "& { try { $targets = @(\"the-small-pos.admin_dashboard_url\", \"the-small-pos.terminal_id\", \"the-small-pos.pos_api_key\", \"the-small-pos.branch_id\", \"the-small-pos.organization_id\", \"the-small-pos.business_type\", \"the-small-pos.supabase_url\", \"the-small-pos.supabase_anon_key\", \"the-small-pos.ghost_mode_feature_enabled\"); foreach ($$t in $$targets) { cmdkey /delete:$$t 2>$$null } } catch {} }"'
  ${EndIf}
!macroend
