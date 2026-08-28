const fs = require('node:fs')
const path = require('node:path')

const target = path.join(__dirname, '..', 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'assistedInstaller.nsh')
if (!fs.existsSync(target)) process.exit(0)
const source = fs.readFileSync(target, 'utf8')
const block = `    # sanitize the MUI_PAGE_DIRECTORY result to make sure it has a application name sub-folder\n    Function instFilesPre\n      \${StrContains} $0 "\${APP_FILENAME}" $INSTDIR\n      \${If} $0 == ""\n        StrCpy $INSTDIR "$INSTDIR\\\${APP_FILENAME}"\n      \${endIf}\n    FunctionEnd\n`
if (source.includes(block)) {
  let next = source.replace(block, '    # Keep the directory selected by the user as the final install directory.\n')
  next = next.replace('    !insertmacro skipPageIfUpdated\n    !insertmacro MUI_PAGE_DIRECTORY', '    !insertmacro MUI_PAGE_DIRECTORY')
  fs.writeFileSync(target, next, 'utf8')
  console.log('NSIS installer directory normalization disabled.')
}
