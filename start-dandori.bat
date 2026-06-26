@echo off
rem 段取り（Dandori）起動用（Windows・ウィンドウ表示版）
rem ローカルサーバーを最小化で起動し、ブラウザでアプリを開きます。
rem スタートアップに入れるなら start-dandori.vbs（非表示版）のショートカットがおすすめです。

cd /d "%~dp0"
start "Dandori server" /min python -m http.server 8000
timeout /t 2 >nul
start "" http://localhost:8000/index.html
