' Launch OrdisOverlay with --no-sandbox.
' Double-click this file. Do NOT double-click OrdisOverlay.exe directly:
' on some machines Electron renderer sandbox makes it quit immediately.

Option Explicit

Dim sh, fso, base, exe, args
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

base = fso.GetParentFolderName(WScript.ScriptFullName)
exe = base & "\OrdisOverlay.exe"

If Not fso.FileExists(exe) Then
  MsgBox "Cannot find OrdisOverlay.exe:" & vbCrLf & exe, vbCritical, "Ordis Overlay"
  WScript.Quit 1
End If

sh.CurrentDirectory = base
args = """" & exe & """ --no-sandbox"
sh.Run args, 1, False
