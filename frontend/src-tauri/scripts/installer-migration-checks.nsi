; CI-only fixture harness. No real app/installer is started or uninstalled.
Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${CHECK_OUTPUT}"
!include LogicLib.nsh
!include FileFunc.nsh
!include WordFunc.nsh
!include Win\COM.nsh
!define VERSION "0.8.11"
!define OATS_RECORDS_ROOT "Software\OatsInstallerFixture\${FIXTURE_ID}"
!include "oats-install-migration.nsh"
Var FixtureRoot
Var Checks

!macro CheckEqual ACTUAL EXPECTED LABEL
  ${If} "${ACTUAL}" != "${EXPECTED}"
    FileOpen $9 "$FixtureRoot\failed.txt" w
    FileWrite $9 '${LABEL}: expected [${EXPECTED}], got [${ACTUAL}]$\r$\n'
    FileClose $9
    SetErrorLevel 1
    Quit
  ${EndIf}
  IntOp $Checks $Checks + 1
!macroend

Section
  StrCpy $FixtureRoot "$TEMP\oats-native-fixtures-${FIXTURE_ID}"
  CreateDirectory "$FixtureRoot"
  System::Call 'kernel32::GetLongPathNameW(w "$FixtureRoot",w .r0,i ${NSIS_MAX_STRLEN})'
  StrCpy $FixtureRoot $0
  CreateDirectory "$FixtureRoot\old app"
  CreateDirectory "$FixtureRoot\current app"
  CreateDirectory "$FixtureRoot\foreign"
  CreateDirectory "$FixtureRoot\legacy"
  CreateDirectory "$FixtureRoot\missing uninstaller"
  SetOutPath "$FixtureRoot\old app"
  File /oname=xx.exe "${FIXTURE_INPUT}\old.exe"
  SetOutPath "$FixtureRoot\current app"
  File /oname=xx.exe "${FIXTURE_INPUT}\current.exe"
  SetOutPath "$FixtureRoot\legacy"
  File /oname=xx.exe "${FIXTURE_INPUT}\legacy.exe"
  SetOutPath "$FixtureRoot\foreign"
  File /oname=xx.exe "${FIXTURE_INPUT}\foreign.exe"
  SetOutPath "$FixtureRoot\missing uninstaller"
  File /oname=xx.exe "${FIXTURE_INPUT}\old.exe"
  FileOpen $0 "$FixtureRoot\old app\uninstall.exe" w
  FileClose $0
  FileOpen $0 "$FixtureRoot\current app\uninstall.exe" w
  FileClose $0
  FileOpen $0 "$FixtureRoot\legacy\uninstall.exe" w
  FileClose $0
  FileOpen $0 "$FixtureRoot\foreign\uninstall.exe" w
  FileClose $0
  FileOpen $0 "$FixtureRoot\old app\notes-sentinel.txt" w
  FileWrite $0 "Keep my notes and recordings"
  FileClose $0

  StrCpy $OatsCandidate "$FixtureRoot\old app"
  Call OatsVerifyInstallation
  !insertmacro CheckEqual $OatsVerified 1 "old metadata recognised"
  !insertmacro CheckEqual $OatsInstalledVersion "0.8.5.0" "PE version extracted"
  StrCpy $OatsCandidate '$\"$FixtureRoot\old app$\"'
  Call OatsVerifyInstallation
  !insertmacro CheckEqual $OatsVerified 1 "quoted registry path recognised"
  StrCpy $OatsCandidate "$FixtureRoot\legacy"
  Call OatsVerifyInstallation
  !insertmacro CheckEqual $OatsVerified 1 "legacy xx product recognised"
  StrCpy $OatsCandidate "$FixtureRoot\foreign"
  Call OatsVerifyInstallation
  !insertmacro CheckEqual $OatsVerified 0 "unrelated xx executable rejected"
  StrCpy $OatsCandidate "$FixtureRoot\missing uninstaller"
  Call OatsVerifyInstallation
  !insertmacro CheckEqual $OatsVerified 0 "incomplete install rejected"
  StrCpy $OatsCandidate "relative\old app"
  Call OatsVerifyInstallation
  !insertmacro CheckEqual $OatsVerified 0 "relative path rejected"

  StrCpy $INSTDIR "$FixtureRoot\fresh"
  StrCpy $OatsDiscovered 0
  StrCpy $OatsCandidate "$FixtureRoot\old app"
  Call OatsConsiderCandidate
  !insertmacro CheckEqual $INSTDIR "$FixtureRoot\old app" "upgrade existing location instead of duplicate"
  StrCpy $INSTDIR "$FixtureRoot\current app"
  StrCpy $OatsDiscovered 0
  StrCpy $OatsCandidate $INSTDIR
  Call OatsConsiderCandidate
  StrCpy $OatsCandidate "$FixtureRoot\old app"
  Call OatsConsiderCandidate
  !insertmacro CheckEqual $INSTDIR "$FixtureRoot\current app" "prefer established current destination"

  StrCpy $OatsLink "$FixtureRoot\oats.lnk"
  CreateShortcut "$OatsLink" "$FixtureRoot\old app\xx.exe" "--fixture"
  Call OatsCandidateFromShortcut
  !insertmacro CheckEqual $OatsCandidate "$FixtureRoot\old app" "discover from stale shortcut"
  StrCpy $OatsRepairFailed 0
  Call OatsRepairOneShortcut
  !insertmacro CheckEqual $OatsRepairFailed 0 "separate-install shortcut repaired"
  Call OatsReadShortcut
  !insertmacro CheckEqual $OatsTarget "$FixtureRoot\current app\xx.exe" "reopen points to current version"
  Call OatsRepairOneShortcut
  !insertmacro CheckEqual $OatsRepairFailed 0 "repair is repeatable"
  ; Read arguments directly: retargeting must preserve user arguments.
  !insertmacro ComHlpr_CreateInProcInstance ${CLSID_ShellLink} ${IID_IShellLink} r0 ""
  ${IUnknown::QueryInterface} $0 '("${IID_IPersistFile}",.r1)'
  ${IPersistFile::Load} $1 '("$OatsLink",0)'
  ${IShellLink::GetArguments} $0 '(.r3,${NSIS_MAX_STRLEN})'
  ${IUnknown::Release} $1 ""
  ${IUnknown::Release} $0 ""
  !insertmacro CheckEqual $3 "--fixture" "custom launch arguments preserved"
  StrCpy $OatsLink "$FixtureRoot\foreign.lnk"
  CreateShortcut "$OatsLink" "$FixtureRoot\foreign\xx.exe"
  Call OatsRepairOneShortcut
  Call OatsReadShortcut
  !insertmacro CheckEqual $OatsTarget "$FixtureRoot\foreign\xx.exe" "unrelated shortcut preserved"
  StrCpy $OatsLink "$FixtureRoot\broken.lnk"
  CreateShortcut "$OatsLink" "$FixtureRoot\missing\xx.exe"
  Call OatsRepairOneShortcut
  Call OatsReadShortcut
  !insertmacro CheckEqual $OatsTarget "$FixtureRoot\missing\xx.exe" "unverified broken shortcut preserved"

  ; Registry fixture is under a unique test-only key, not actual oats records.
  WriteRegStr HKCU "${OATS_RECORDS_ROOT}\Microsoft\Windows\CurrentVersion\Uninstall\xx" "InstallLocation" '$\"$FixtureRoot\old app$\"'
  StrCpy $INSTDIR "$FixtureRoot\fresh"
  Call OatsDiscoverInstallation
  !insertmacro CheckEqual $INSTDIR "$FixtureRoot\old app" "missing manufacturer key uses uninstall record"
  DeleteRegKey HKCU "${OATS_RECORDS_ROOT}"
  FileOpen $0 "$FixtureRoot\old app\notes-sentinel.txt" r
  FileRead $0 $1
  FileClose $0
  !insertmacro CheckEqual $1 "Keep my notes and recordings" "old data preserved"
  IfFileExists "$FixtureRoot\old app\xx.exe" +2 0
    Abort "Separate old copies must not be deleted by discovery/repair"
  IntOp $Checks $Checks + 1
  FileOpen $0 "$FixtureRoot\passed.txt" w
  FileWrite $0 "$Checks checks passed"
  FileClose $0
  SetErrorLevel 0
SectionEnd
