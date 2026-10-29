!define OATS_MIGRATION_INCLUDE "${__FILEDIR__}\oats-install-migration.nsh"

; Preserve only the existing data-location pointer, never notes, runtime files or
; models. PREINSTALL is too late for manual upgrades: the reinstall page may run
; the old uninstaller first. Our template calls this in .onInit and again before
; invoking that uninstaller. Existing saved choices are never overwritten.
!macro OATS_PRESERVE_DATA_LOCATION INSTALL_LOCATION
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $0 "${INSTALL_LOCATION}\sttapp-local-install.json"
  StrCpy $1 "$LOCALAPPDATA\STTApp\data-location.json"
  ${If} ${FileExists} "$0"
  ${AndIfNot} ${FileExists} "$1"
    CreateDirectory "$LOCALAPPDATA\STTApp"
    ; Copy byte-for-byte into our own unique temporary file, then publish by
    ; same-directory rename without replacement. A failed copy never exposes
    ; a partial saved choice. A concurrent choice causes a safe install abort.
    ClearErrors
    GetTempFileName $2 "$LOCALAPPDATA\STTApp"
    ${IfNot} ${Errors}
      System::Call 'kernel32::CopyFileW(w r0, w r2, i 0) i .r3'
      ${If} $3 <> 0
        System::Call 'kernel32::MoveFileW(w r2, w r1) i .r3'
      ${EndIf}
      Delete "$2" ; only our generated temporary file; absent after rename
    ${Else}
      StrCpy $3 0
    ${EndIf}
    ${If} $3 = 0
      Pop $3
      Pop $2
      Pop $1
      Pop $0
      MessageBox MB_OK|MB_ICONSTOP "oats could not preserve the existing notes location. Installation has stopped before removing the previous app. Check access to your local STTApp folder and try again." /SD IDOK
      SetErrorLevel 2
      Abort
    ${EndIf}
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

; Rename or remove only old shortcuts that point to this installation.
!macro NSIS_HOOK_POSTINSTALL
  ${If} $NoShortcutMode <> 1
    Call OatsRepairShortcuts
    ${If} $OatsRepairFailed = 1
      MessageBox MB_OK|MB_ICONSTOP "oats was installed, but a shortcut could not be repaired. Open $INSTDIR\${MAINBINARYNAME}.exe directly and retry setup to repair the shortcut. No separate installation was deleted." /SD IDOK
      SetErrorLevel 2
      Abort
    ${EndIf}
    !insertmacro IsShortcutTarget "$SMPROGRAMS\xx.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      ; /UPDATE may retain the previous Start menu shortcut instead of
      ; creating one under the new display name. Preserve that entry.
      ${IfNot} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
        !insertmacro UnpinShortcut "$SMPROGRAMS\xx.lnk"
        Rename "$SMPROGRAMS\xx.lnk" "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      ${Else}
        !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
        Pop $0
        ${If} $0 = 1
          !insertmacro UnpinShortcut "$SMPROGRAMS\xx.lnk"
          Delete "$SMPROGRAMS\xx.lnk"
        ${EndIf}
      ${EndIf}
    ${EndIf}
    !insertmacro IsShortcutTarget "$DESKTOP\xx.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      ; Preserve an existing desktop shortcut even when the installer finish
      ; page is not asked to create a new one. Never replace another shortcut.
      ${IfNot} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
        !insertmacro UnpinShortcut "$DESKTOP\xx.lnk"
        Rename "$DESKTOP\xx.lnk" "$DESKTOP\${PRODUCTNAME}.lnk"
      ${Else}
        !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
        Pop $0
        ${If} $0 = 1
          !insertmacro UnpinShortcut "$DESKTOP\xx.lnk"
          Delete "$DESKTOP\xx.lnk"
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
