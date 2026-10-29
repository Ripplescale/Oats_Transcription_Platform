; Installation discovery and shortcut repair run inside NSIS. No extra process,
; script host, old executable or old uninstaller is launched by these functions.
; Inputs/outputs use dedicated variables; callers must not depend on $0..$9.
Var OatsCandidate
Var OatsVerified
Var OatsDiscovered
Var OatsLink
Var OatsTarget
Var OatsRepairFailed
Var OatsRepairOriginal
Var OatsInstalledVersion

!ifndef OATS_RECORDS_ROOT
  !define OATS_RECORDS_ROOT "Software"
!endif

Function OatsVerifyInstallation
  StrCpy $OatsVerified 0
  StrCpy $OatsInstalledVersion ""
  ; Registry InstallLocation is sometimes quoted. Remove matching outer quotes.
  StrCpy $0 $OatsCandidate 1
  StrCpy $1 $OatsCandidate 1 -1
  ${If} $0 == '$\"'
  ${AndIf} $1 == '$\"'
    StrCpy $OatsCandidate $OatsCandidate -1 1
  ${EndIf}
  ; Automatic migration accepts only absolute local paths.
  StrCpy $0 $OatsCandidate 1 1
  StrCpy $1 $OatsCandidate 1 2
  ${If} $0 != ":"
  ${OrIf} $1 != "\"
    Return
  ${EndIf}
  GetFullPathName $OatsCandidate "$OatsCandidate"
  IfFileExists "$OatsCandidate\xx.exe" 0 oats_verify_done
  IfFileExists "$OatsCandidate\uninstall.exe" 0 oats_verify_done
  ; Never traverse junctions or symbolic links during automatic discovery.
  StrCpy $8 "$OatsCandidate\xx.exe"
  oats_verify_parent:
    System::Call 'kernel32::GetFileAttributesW(w r8)i.r9'
    ${If} $9 = -1
      Return
    ${EndIf}
    IntOp $9 $9 & 0x400
    ${If} $9 <> 0
      Return
    ${EndIf}
    StrCpy $9 $8
    ${GetParent} $8 $8
    ${If} $8 != ""
    ${AndIf} $8 != $9
      Goto oats_verify_parent
    ${EndIf}
  ; Inspect PE version resources; a file called xx.exe alone is insufficient.
  ClearErrors
  GetDLLVersion "$OatsCandidate\xx.exe" $8 $9
  IfErrors oats_verify_done
  IntOp $0 $8 >> 16
  IntOp $1 $8 & 0xffff
  IntOp $2 $9 >> 16
  IntOp $3 $9 & 0xffff
  StrCpy $OatsInstalledVersion "$0.$1.$2.$3"
  System::Call 'version::GetFileVersionInfoSizeW(w "$OatsCandidate\xx.exe",p 0)i.r0'
  ${If} $0 = 0
    Return
  ${EndIf}
  System::Alloc $0
  Pop $1
  ${If} $1 P= 0
    Return
  ${EndIf}
  System::Call 'version::GetFileVersionInfoW(w "$OatsCandidate\xx.exe",i 0,i r0,p r1)i.r4'
  ${If} $4 <> 0
    System::Call 'version::VerQueryValueW(p r1,w "\VarFileInfo\Translation",*p.r2,*i.r3)i.r4'
    ${If} $4 <> 0
    ${AndIf} $3 >= 4
      System::Call '*$2(&i2.r5,&i2.r6)'
      IntFmt $5 "%04x" $5
      IntFmt $6 "%04x" $6
      StrCpy $7 "\StringFileInfo\$5$6\ProductName"
      System::Call 'version::VerQueryValueW(p r1,w r7,*p.r2,*i.r3)i.r4'
      ${If} $4 <> 0
        System::Call 'kernel32::lstrcpynW(w .r7,p r2,i ${NSIS_MAX_STRLEN})'
        ${If} $7 == "oats"
        ${OrIf} $7 == "xx"
          StrCpy $OatsVerified 1
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  System::Free $1
  oats_verify_done:
FunctionEnd

; Read links with the same native ShellLink COM interfaces used by NSIS itself.
Function OatsReadShortcut
  StrCpy $OatsTarget ""
  IfFileExists "$OatsLink" 0 oats_read_done
  StrCpy $0 0
  !insertmacro ComHlpr_CreateInProcInstance ${CLSID_ShellLink} ${IID_IShellLink} r0 ""
  ${If} $0 P<> 0
    StrCpy $1 0
    ${IUnknown::QueryInterface} $0 '("${IID_IPersistFile}",.r1)'
    ${If} $1 P<> 0
      ${IPersistFile::Load} $1 '("$OatsLink",0).r2'
      ${If} $2 = 0
        ${IShellLink::GetPath} $0 '(.r3,${NSIS_MAX_STRLEN},0,0).r2'
        ${If} $2 = 0
          StrCpy $OatsTarget $3
        ${EndIf}
      ${EndIf}
      ${IUnknown::Release} $1 ""
    ${EndIf}
    ${IUnknown::Release} $0 ""
  ${EndIf}
  oats_read_done:
FunctionEnd

Function OatsCandidateFromShortcut
  StrCpy $OatsCandidate ""
  Call OatsReadShortcut
  ${GetFileName} $OatsTarget $0
  ${If} $0 == "xx.exe"
    ${GetParent} $OatsTarget $OatsCandidate
  ${EndIf}
FunctionEnd

Function OatsConsiderCandidate
  ${If} $OatsDiscovered = 1
    Return
  ${EndIf}
  Call OatsVerifyInstallation
  ${If} $OatsVerified = 1
    ${VersionCompare} $OatsInstalledVersion "${VERSION}" $0
    ${If} $0 = 1
      MessageBox MB_OK|MB_ICONSTOP "A newer version of oats is already installed at $OatsCandidate. Setup stopped without changing it." /SD IDOK
      SetErrorLevel 2
      Abort
    ${EndIf}
    StrCpy $INSTDIR $OatsCandidate
    StrCpy $OatsDiscovered 1
  ${EndIf}
FunctionEnd

!macro OATS_TRY_RECORD KEY VALUE
  ReadRegStr $OatsCandidate SHCTX "${KEY}" "${VALUE}"
  Call OatsConsiderCandidate
!macroend

Function OatsDiscoverInstallation
  StrCpy $OatsDiscovered 0
  ; Keep an established current destination when multiple copies already exist.
  StrCpy $OatsCandidate $INSTDIR
  Call OatsConsiderCandidate
  !insertmacro OATS_TRY_RECORD "${OATS_RECORDS_ROOT}\xx\xx" ""
  !insertmacro OATS_TRY_RECORD "${OATS_RECORDS_ROOT}\oats\oats" ""
  !insertmacro OATS_TRY_RECORD "${OATS_RECORDS_ROOT}\Microsoft\Windows\CurrentVersion\Uninstall\xx" "InstallLocation"
  !insertmacro OATS_TRY_RECORD "${OATS_RECORDS_ROOT}\Microsoft\Windows\CurrentVersion\Uninstall\oats" "InstallLocation"
  StrCpy $OatsLink "$SMPROGRAMS\oats.lnk"
  Call OatsCandidateFromShortcut
  Call OatsConsiderCandidate
  StrCpy $OatsLink "$SMPROGRAMS\xx.lnk"
  Call OatsCandidateFromShortcut
  Call OatsConsiderCandidate
  StrCpy $OatsLink "$DESKTOP\oats.lnk"
  Call OatsCandidateFromShortcut
  Call OatsConsiderCandidate
  StrCpy $OatsLink "$DESKTOP\xx.lnk"
  Call OatsCandidateFromShortcut
  Call OatsConsiderCandidate
  StrCpy $OatsCandidate "$LOCALAPPDATA\xx"
  Call OatsConsiderCandidate
FunctionEnd

Function OatsRepairOneShortcut
  IfFileExists "$OatsLink" 0 oats_repair_done
  Call OatsCandidateFromShortcut
  StrCpy $OatsRepairOriginal $OatsTarget
  Call OatsVerifyInstallation
  ${If} $OatsVerified <> 1
    Return
  ${EndIf}
  StrCpy $0 0
  !insertmacro ComHlpr_CreateInProcInstance ${CLSID_ShellLink} ${IID_IShellLink} r0 ""
  ${If} $0 P<> 0
    StrCpy $1 0
    ${IUnknown::QueryInterface} $0 '("${IID_IPersistFile}",.r1)'
    ${If} $1 P<> 0
      ${IPersistFile::Load} $1 '("$OatsLink",0).r2'
      ${If} $2 = 0
        ${IShellLink::GetPath} $0 '(.r3,${NSIS_MAX_STRLEN},0,0).r2'
        ${If} $2 = 0
        ${AndIf} $3 == $OatsRepairOriginal
          ${IShellLink::SetPath} $0 '("$INSTDIR\xx.exe").r2'
          ${If} $2 = 0
            ${IShellLink::SetWorkingDirectory} $0 '("$INSTDIR").r2'
            ${If} $2 = 0
              ${IShellLink::SetIconLocation} $0 '("$INSTDIR\xx.exe",0).r2'
              ${If} $2 = 0
                ${IPersistFile::Save} $1 '("$OatsLink",1).r2'
              ${EndIf}
            ${EndIf}
          ${EndIf}
        ${EndIf}
      ${EndIf}
      ${IUnknown::Release} $1 ""
    ${EndIf}
    ${IUnknown::Release} $0 ""
  ${EndIf}
  Call OatsReadShortcut
  ${If} $OatsTarget != "$INSTDIR\xx.exe"
    StrCpy $OatsRepairFailed 1
  ${EndIf}
  oats_repair_done:
FunctionEnd

Function OatsRepairShortcuts
  StrCpy $OatsRepairFailed 0
  StrCpy $OatsCandidate $INSTDIR
  Call OatsVerifyInstallation
  ${If} $OatsVerified <> 1
    StrCpy $OatsRepairFailed 1
    Return
  ${EndIf}
  StrCpy $OatsLink "$SMPROGRAMS\oats.lnk"
  Call OatsRepairOneShortcut
  StrCpy $OatsLink "$SMPROGRAMS\xx.lnk"
  Call OatsRepairOneShortcut
  StrCpy $OatsLink "$DESKTOP\oats.lnk"
  Call OatsRepairOneShortcut
  StrCpy $OatsLink "$DESKTOP\xx.lnk"
  Call OatsRepairOneShortcut
  StrCpy $OatsLink "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\oats.lnk"
  Call OatsRepairOneShortcut
  StrCpy $OatsLink "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\xx.lnk"
  Call OatsRepairOneShortcut
  System::Call 'shell32::SHChangeNotify(i 0x08000000,i 0,p 0,p 0)'
FunctionEnd
