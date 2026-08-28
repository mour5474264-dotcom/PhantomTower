; Export directory is configured in the application settings page.
; Keep the installer free of sidecar files in the installation directory.
!macro customInstall
  Delete "$INSTDIR\export-dir.txt"
!macroend
