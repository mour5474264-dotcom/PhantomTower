!ifndef BUILD_UNINSTALLER
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

Var ExportDirectory
Var ExportDirectoryInput
Var ExportDirectoryBrowse

!macro customPageAfterChangeDir
  Page custom ExportDirectoryPage ExportDirectoryPageLeave
!macroend

Function ExportDirectoryPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 25u "请选择图片导出文件夹。以后下载和批量导出的图片会自动保存到此处。"
  Pop $0
  ${NSD_CreateText} 0 32u 76% 12u "$DOCUMENTS\PhantomTower Exports"
  Pop $ExportDirectoryInput
  ${NSD_CreateBrowseButton} 78% 32u 22% 12u "浏览..."
  Pop $ExportDirectoryBrowse
  ${NSD_OnClick} $ExportDirectoryBrowse ExportDirectoryBrowse
  nsDialogs::Show
FunctionEnd

Function ExportDirectoryBrowse
  nsDialogs::SelectFolderDialog "选择图片导出文件夹" "$DOCUMENTS"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $ExportDirectoryInput "$0"
  ${EndIf}
FunctionEnd

Function ExportDirectoryPageLeave
  ${NSD_GetText} $ExportDirectoryInput $ExportDirectory
  ${If} $ExportDirectory == ""
    MessageBox MB_ICONEXCLAMATION "请选择图片导出文件夹。"
    Abort
  ${EndIf}
  CreateDirectory "$ExportDirectory"
  FileOpen $0 "$INSTDIR\export-dir.txt" w
  FileWrite $0 "$ExportDirectory"
  FileClose $0
FunctionEnd
!endif
