' 段取り（Dandori）自動起動用スクリプト（Windows）
' ローカルサーバーを「隠れて」起動し、既定のブラウザでアプリを開きます。
' このファイルへの「ショートカット」をスタートアップ フォルダに入れると、PC起動時に自動で開きます。
'   1) Win+R →「shell:startup」と入力して Enter（スタートアップ フォルダが開く）
'   2) この start-dandori.vbs を右クリック →「コピー」
'   3) スタートアップ フォルダで右クリック →「ショートカットの貼り付け」
Option Explicit

Dim sh, fso, here, port, url
port = 8000
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' このスクリプトが置かれているフォルダ（＝アプリ本体のフォルダ）を配信する
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here

' ローカルサーバーを非表示で起動（0 = ウィンドウを表示しない / False = 終了を待たない）
sh.Run "python -m http.server " & port, 0, False

' サーバーが立ち上がるのを少し待ってからブラウザで開く
WScript.Sleep 2000

url = "http://localhost:" & port & "/index.html"
sh.Run url, 1, False
