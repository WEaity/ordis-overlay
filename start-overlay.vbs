' start-overlay.vbs - start the overlay with no console window at all.
' Double-click this file (or a shortcut to it). The backend is started by main.js.

Option Explicit

Dim sh, fso, base, exe, args
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

base = fso.GetParentFolderName(WScript.ScriptFullName)
exe = base & "\node_modules\electron\dist\electron.exe"

If Not fso.FileExists(exe) Then
  MsgBox "Cannot find electron.exe:" & vbCrLf & exe & vbCrLf & vbCrLf & _
         "Did you run npm install in this folder?", vbCritical, "Overlay"
  WScript.Quit 1
End If

sh.CurrentDirectory = base
args = """" & exe & """ """ & base & """ --no-sandbox"

' Window style 1 = normal (electron.exe is a GUI app, so no console appears anyway).
' Do NOT use 0 here: SW_HIDE can be inherited by the overlay window itself.
sh.Run args, 1, False
