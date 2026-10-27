' MoodTune - silent launcher (double-click me)
' Starts the local server with no console window, then opens the browser.
Option Explicit

Dim fso, sh, appDir, already, i, req, hasNode, hasPy, ok
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
appDir  = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = appDir
Set req = CreateObject("MSXML2.XMLHTTP")

' --- 1. Is a server already running? ---
already = False
For i = 8010 To 8015
  Err.Clear
  On Error Resume Next
  req.Open "GET", "http://localhost:" & i & "/data/songs.json", False
  req.Send
  If Err.Number = 0 And req.Status = 200 Then
    already = True
  End If
  On Error GoTo 0
  If already Then
    sh.Run "http://localhost:" & i & "/", 1, False
    Exit For
  End If
Next

If already Then
  Set fso = Nothing
  Set sh = Nothing
  WScript.Quit
End If

' --- 2. Prefer Node (it picks a free port and opens the browser itself) ---
hasNode = (sh.Run("cmd /c where node >nul 2>nul", 0, True) = 0)

If hasNode Then
  sh.Run "cmd /c cd /d """ & appDir & """ && node server.js", 0, False
  WScript.Sleep 3000

  ok = False
  For i = 8010 To 8015
    Err.Clear
    On Error Resume Next
    req.Open "GET", "http://localhost:" & i & "/data/songs.json", False
    req.Send
    If Err.Number = 0 And req.Status = 200 Then
      ok = True
    End If
    On Error GoTo 0
    If ok Then Exit For
  Next

  If Not ok Then
    MsgBox "The local server did not start." & vbCrLf & vbCrLf & _
           "Please double-click start.bat instead - it keeps a window open" & vbCrLf & _
           "so you can read the error message.", _
           vbExclamation, "MoodTune"
  End If
  WScript.Quit
End If

' --- 3. Fall back to Python ---
hasPy = (sh.Run("cmd /c where python >nul 2>nul", 0, True) = 0)

If hasPy Then
  sh.Run "cmd /c cd /d """ & appDir & """ && python -m http.server 8010", 0, False
  WScript.Sleep 1500
  sh.Run "http://localhost:8010/", 1, False
  WScript.Quit
End If

' --- 4. Nothing available ---
MsgBox "Node.js or Python was not found." & vbCrLf & vbCrLf & _
       "Please install Node.js from https://nodejs.org" & vbCrLf & _
       "then double-click this file again.", _
       vbExclamation, "MoodTune"
